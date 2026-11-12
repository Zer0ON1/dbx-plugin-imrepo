package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// AWS credentials for ECR, resolved in the same order the AWS SDKs use:
//
//  1. explicit Access Key ID / Secret Access Key from the connection (plus an
//     optional session token for temporary STS credentials);
//  2. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN;
//  3. an explicitly named profile, or the default profile, from the shared
//     credentials/config files (or AWS_PROFILE);
//  4. ECS container credentials;
//  5. EC2 instance metadata (IMDSv2) for an instance role.
//
// SSO profiles, role_arn profiles and credential_process are deliberately not
// executed here: they either need an AWS SDK token-refresh flow or run an
// arbitrary local command. They get an explicit error instead of a silent
// failure. The region falls back to AWS_REGION / AWS_DEFAULT_REGION / the
// profile's region when the form leaves it empty.

type awsCredentials struct {
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
	Region          string
}

func resolveAwsCredentials(conn *Connection) (*awsCredentials, error) {
	region := strings.TrimSpace(conn.configStr("region"))
	if region == "" {
		region = firstEnv("AWS_REGION", "AWS_DEFAULT_REGION")
	}

	accessKey := strings.TrimSpace(conn.configStr("access_key_id"))
	secretKey := strings.TrimSpace(conn.secretStr("secret_access_key"))
	sessionToken := strings.TrimSpace(conn.secretStr("session_token"))
	if sessionToken == "" {
		sessionToken = strings.TrimSpace(conn.configStr("session_token"))
	}
	if accessKey != "" || secretKey != "" {
		if accessKey == "" || secretKey == "" {
			return nil, fmt.Errorf("AWS ECR: both access_key_id and secret_access_key are required; leave both empty to use the AWS credential chain")
		}
		if region == "" {
			return nil, fmt.Errorf("AWS ECR: region is required")
		}
		return &awsCredentials{
			AccessKeyID: accessKey, SecretAccessKey: secretKey,
			SessionToken: sessionToken, Region: region,
		}, nil
	}

	// An explicitly selected profile wins over the environment, matching what a
	// user means by "use this profile"; an unset one takes the SDK order.
	profile := strings.TrimSpace(conn.configStr("aws_profile"))
	explicitProfile := profile != ""
	if !explicitProfile {
		profile = strings.TrimSpace(os.Getenv("AWS_PROFILE"))
		explicitProfile = profile != ""
	}
	if !explicitProfile {
		if creds := envAwsCredentials(region); creds != nil {
			return withRequiredRegion(creds, "AWS_ACCESS_KEY_ID")
		}
		profile = "default"
	}

	creds, err := sharedProfileCredentials(profile, region)
	if err != nil {
		return nil, err
	}
	if creds != nil {
		if creds.Region == "" {
			return nil, fmt.Errorf("AWS ECR: region is required (set it on the connection or as AWS_REGION)")
		}
		return creds, nil
	}
	if explicitProfile {
		return nil, fmt.Errorf("AWS ECR: profile %q has no static credentials in the shared credentials file", profile)
	}

	if creds := ecsAwsCredentials(region); creds != nil {
		return withRequiredRegion(creds, "ECS task role")
	}
	if creds := imdsAwsCredentials(region); creds != nil {
		return withRequiredRegion(creds, "EC2 instance role")
	}
	return nil, fmt.Errorf("AWS ECR: no credentials found — fill in Access Key ID/Secret, set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, configure ~/.aws/credentials, attach an ECS task role, or run on an EC2 instance role")
}

func envAwsCredentials(region string) *awsCredentials {
	accessKey := strings.TrimSpace(os.Getenv("AWS_ACCESS_KEY_ID"))
	secretKey := strings.TrimSpace(os.Getenv("AWS_SECRET_ACCESS_KEY"))
	if accessKey == "" || secretKey == "" {
		return nil
	}
	return &awsCredentials{
		AccessKeyID: accessKey, SecretAccessKey: secretKey,
		SessionToken: strings.TrimSpace(os.Getenv("AWS_SESSION_TOKEN")),
		Region:       region,
	}
}

// sharedProfileCredentials reads ~/.aws/credentials and ~/.aws/config. It
// returns (nil, nil) when the profile simply does not exist. A profile that
// relies on SSO / role_arn / credential_process returns an error that names the
// unsupported mechanism, because falling through to instance metadata would be
// a misleading "no credentials" message.
func sharedProfileCredentials(profile, region string) (*awsCredentials, error) {
	credentialsPath := strings.TrimSpace(os.Getenv("AWS_SHARED_CREDENTIALS_FILE"))
	if credentialsPath == "" {
		if home, err := os.UserHomeDir(); err == nil {
			credentialsPath = filepath.Join(home, ".aws", "credentials")
		}
	}
	configPath := strings.TrimSpace(os.Getenv("AWS_CONFIG_FILE"))
	if configPath == "" {
		if home, err := os.UserHomeDir(); err == nil {
			configPath = filepath.Join(home, ".aws", "config")
		}
	}

	credentials, _ := parseAWSINI(credentialsPath)
	config, _ := parseAWSINI(configPath)
	configSection := profile
	if profile != "default" {
		configSection = "profile " + profile
	}

	credSection := credentials[profile]
	cfgSection := config[configSection]
	if cfgSection == nil && profile == "default" {
		cfgSection = config["default"]
	}
	merged := map[string]string{}
	for k, v := range cfgSection {
		merged[k] = v
	}
	for k, v := range credSection {
		merged[k] = v
	}
	if len(merged) == 0 {
		return nil, nil
	}

	accessKey := strings.TrimSpace(merged["aws_access_key_id"])
	secretKey := strings.TrimSpace(merged["aws_secret_access_key"])
	if accessKey == "" || secretKey == "" {
		for _, unsupported := range []string{
			"sso_session", "sso_start_url", "sso_account_id", "sso_role_name",
			"role_arn", "credential_process", "web_identity_token_file",
		} {
			if strings.TrimSpace(merged[unsupported]) != "" {
				return nil, fmt.Errorf("AWS ECR: profile %q uses %s, which this plugin does not support; use static access keys, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, an ECS/EC2 role, or the AWS CLI with Docker", profile, unsupported)
			}
		}
		return nil, nil
	}
	if region == "" {
		region = strings.TrimSpace(merged["region"])
	}
	return &awsCredentials{
		AccessKeyID: accessKey, SecretAccessKey: secretKey,
		SessionToken: strings.TrimSpace(merged["aws_session_token"]),
		Region:       region,
	}, nil
}

// parseAWSINI is a deliberately small INI reader for the AWS shared files:
// sections, key=value, comments and quoted values. It is not a general INI
// parser, and returns an empty map for a missing/unreadable file.
func parseAWSINI(path string) (map[string]map[string]string, error) {
	out := map[string]map[string]string{}
	if path == "" {
		return out, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return out, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	section := ""
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.TrimSpace(line[1 : len(line)-1])
			if out[section] == nil {
				out[section] = map[string]string{}
			}
			continue
		}
		if section == "" {
			continue
		}
		if i := strings.IndexByte(line, '='); i > 0 {
			key := strings.TrimSpace(line[:i])
			value := strings.TrimSpace(line[i+1:])
			value = strings.Trim(value, `"'`)
			out[section][key] = value
		}
	}
	return out, scanner.Err()
}

// ecsAwsCredentials reads the ECS task-role endpoint. The URL comes from the
// standard container environment, so it works in ECS/Fargate without an SDK.
func ecsAwsCredentials(region string) *awsCredentials {
	relative := strings.TrimSpace(os.Getenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"))
	full := strings.TrimSpace(os.Getenv("AWS_CONTAINER_CREDENTIALS_FULL_URI"))
	if relative == "" && full == "" {
		return nil
	}
	endpoint := full
	if endpoint == "" {
		endpoint = "http://169.254.170.2" + relative
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil
	}
	if token := strings.TrimSpace(os.Getenv("AWS_CONTAINER_AUTHORIZATION_TOKEN")); token != "" {
		req.Header.Set("authorization", token)
	}
	return fetchAwsCredentialJSON(req, region)
}

// imdsAwsCredentials uses IMDSv2. It is tried only after every static source,
// so a laptop without instance metadata pays one short timeout and nothing else.
func imdsAwsCredentials(region string) *awsCredentials {
	if strings.EqualFold(strings.TrimSpace(os.Getenv("AWS_EC2_METADATA_DISABLED")), "true") {
		return nil
	}
	base := strings.TrimRight(strings.TrimSpace(os.Getenv("AWS_EC2_METADATA_SERVICE_ENDPOINT")), "/")
	if base == "" {
		base = "http://169.254.169.254"
	}
	client := &http.Client{Timeout: 1 * time.Second}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	tokenReq, err := http.NewRequestWithContext(ctx, http.MethodPut, base+"/latest/api/token", nil)
	if err != nil {
		return nil
	}
	tokenReq.Header.Set("x-aws-ec2-metadata-token-ttl-seconds", "21600")
	tokenResp, err := client.Do(tokenReq)
	if err != nil {
		return nil
	}
	tokenBody, _ := io.ReadAll(io.LimitReader(tokenResp.Body, 4096))
	tokenResp.Body.Close()
	if tokenResp.StatusCode != http.StatusOK {
		return nil
	}
	token := strings.TrimSpace(string(tokenBody))
	if token == "" {
		return nil
	}

	role, err := imdsGet(ctx, client, base+"/latest/meta-data/iam/security-credentials/", token)
	if err != nil {
		return nil
	}
	roleName := strings.TrimSpace(string(role))
	if roleName == "" {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		base+"/latest/meta-data/iam/security-credentials/"+roleName, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("x-aws-ec2-metadata-token", token)
	return fetchAwsCredentialJSON(req, region)
}

func imdsGet(ctx context.Context, client *http.Client, url, token string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-aws-ec2-metadata-token", token)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("metadata endpoint answered %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 64<<10))
}

func fetchAwsCredentialJSON(req *http.Request, region string) *awsCredentials {
	resp, err := (&http.Client{Timeout: 2 * time.Second}).Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var out struct {
		AccessKeyID     string `json:"AccessKeyId"`
		SecretAccessKey string `json:"SecretAccessKey"`
		Token           string `json:"Token"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&out) != nil ||
		out.AccessKeyID == "" || out.SecretAccessKey == "" {
		return nil
	}
	return &awsCredentials{
		AccessKeyID: out.AccessKeyID, SecretAccessKey: out.SecretAccessKey,
		SessionToken: out.Token, Region: region,
	}
}

func withRequiredRegion(creds *awsCredentials, source string) (*awsCredentials, error) {
	if creds == nil {
		return nil, nil
	}
	if strings.TrimSpace(creds.Region) == "" {
		return nil, fmt.Errorf("AWS ECR: region is required when using %s; set it on the connection or as AWS_REGION", source)
	}
	return creds, nil
}

func firstEnv(names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value
		}
	}
	return ""
}
