package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// AWS ECR — SigV4 GetAuthorizationToken
// ---------------------------------------------------------------------------

type awsEcrAuth struct {
	accessKey string
	secretKey string
	region    string
	http      *http.Client
}

func newAwsEcrAuth(conn *Connection) (*awsEcrAuth, error) {
	ak := conn.configStr("access_key_id")
	sk := conn.secretStr("secret_access_key")
	region := conn.configStr("region")
	if ak == "" || sk == "" || region == "" {
		return nil, fmt.Errorf("AWS ECR requires access_key_id, secret_access_key and region")
	}
	return &awsEcrAuth{accessKey: ak, secretKey: sk, region: region, http: httpClient(conn)}, nil
}

func (a *awsEcrAuth) Credential(ctx context.Context) (*Credential, error) {
	body := []byte("{}")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://ecr."+a.region+".amazonaws.com/", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/x-amz-json-1.1")
	req.Header.Set("x-amz-target", "AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken")

	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")
	req.Header.Set("x-amz-date", amzDate)
	req.Host = req.URL.Host

	if err := signV4(req, "ecr", a.region, a.accessKey, a.secretKey, amzDate, dateStamp, sha256Hex(body)); err != nil {
		return nil, err
	}

	resp, err := a.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ECR GetAuthorizationToken failed (%d): %s", resp.StatusCode, truncate(string(data), 300))
	}
	var out struct {
		AuthorizationData []struct {
			AuthorizationToken string `json:"authorizationToken"`
		} `json:"authorizationData"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	if len(out.AuthorizationData) == 0 || out.AuthorizationData[0].AuthorizationToken == "" {
		return nil, fmt.Errorf("ECR returned no authorization token")
	}
	decoded, err := base64.StdEncoding.DecodeString(out.AuthorizationData[0].AuthorizationToken)
	if err != nil {
		return nil, fmt.Errorf("decoding ECR token: %w", err)
	}
	parts := strings.SplitN(string(decoded), ":", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("unexpected ECR token format")
	}
	return &Credential{Scheme: "basic", Username: parts[0], Password: parts[1]}, nil
}

// ---------------------------------------------------------------------------
// Aliyun ACR — RPC signature V1.0 (HMAC-SHA1) GetAuthorizationToken
// ---------------------------------------------------------------------------

type aliyunAuth struct {
	accessKey  string
	secretKey  string
	region     string
	instanceID string
	http       *http.Client
}

func newAliyunAuth(conn *Connection) (*aliyunAuth, error) {
	ak := conn.configStr("access_key_id")
	sk := conn.secretStr("secret_access_key")
	region := conn.configStr("region")
	if ak == "" || sk == "" || region == "" {
		return nil, fmt.Errorf("Aliyun ACR requires access_key_id, secret_access_key and region")
	}
	return &aliyunAuth{accessKey: ak, secretKey: sk, region: region, instanceID: conn.configStr("instance_id"), http: httpClient(conn)}, nil
}

func (a *aliyunAuth) Credential(ctx context.Context) (*Credential, error) {
	params := map[string]string{
		"Action":           "GetAuthorizationToken",
		"Format":           "JSON",
		"Version":          "2018-12-01",
		"AccessKeyId":      a.accessKey,
		"SignatureMethod":  "HMAC-SHA1",
		"SignatureNonce":   nonce(),
		"SignatureVersion": "1.0",
		"Timestamp":        time.Now().UTC().Format("2006-01-02T15:04:05Z"),
		"RegionId":         a.region,
	}
	if a.instanceID != "" {
		params["InstanceId"] = a.instanceID
	}
	params["Signature"] = aliyunSignature(http.MethodGet, params, a.secretKey)

	endpoint := "https://cr." + a.region + ".aliyuncs.com/?" + encodeQuery(params)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := a.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Aliyun GetAuthorizationToken failed (%d): %s", resp.StatusCode, truncate(string(data), 300))
	}
	var out struct {
		Data struct {
			AuthorizationToken string `json:"AuthorizationToken"`
			TempUserName       string `json:"TempUserName"`
			Password           string `json:"Password"`
			UserName           string `json:"UserName"`
		} `json:"Data"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	if out.Data.AuthorizationToken != "" {
		decoded, err := base64.StdEncoding.DecodeString(out.Data.AuthorizationToken)
		if err == nil {
			parts := strings.SplitN(string(decoded), ":", 2)
			if len(parts) == 2 {
				return &Credential{Scheme: "basic", Username: parts[0], Password: parts[1]}, nil
			}
		}
	}
	if out.Data.UserName != "" && out.Data.Password != "" {
		return &Credential{Scheme: "basic", Username: out.Data.UserName, Password: out.Data.Password}, nil
	}
	if out.Data.TempUserName != "" {
		return nil, fmt.Errorf("Aliyun returned no usable token; check instance_id for enterprise edition")
	}
	return nil, fmt.Errorf("Aliyun returned no authorization token")
}

// ---------------------------------------------------------------------------
// Tencent TCR — TC3-HMAC-SHA256 DescribeInstanceToken
// ---------------------------------------------------------------------------

type tencentAuth struct {
	secretID   string
	secretKey  string
	region     string
	instanceID string
	http       *http.Client
}

func newTencentAuth(conn *Connection) (*tencentAuth, error) {
	sid := conn.configStr("secret_id")
	sk := conn.secretStr("secret_key")
	region := conn.configStr("region")
	instanceID := conn.configStr("instance_id")
	if sid == "" || sk == "" || region == "" || instanceID == "" {
		return nil, fmt.Errorf("Tencent TCR requires secret_id, secret_key, region and instance_id")
	}
	return &tencentAuth{secretID: sid, secretKey: sk, region: region, instanceID: instanceID, http: httpClient(conn)}, nil
}

func (a *tencentAuth) Credential(ctx context.Context) (*Credential, error) {
	const host = "tcr.tencentcloudapi.com"
	const service = "tcr"
	payload, _ := json.Marshal(map[string]string{"RegistryId": a.instanceID})

	ts := time.Now().Unix()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://"+host+"/", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json; charset=utf-8")
	req.Header.Set("host", host)
	req.Header.Set("x-tc-action", "DescribeInstanceToken")
	req.Header.Set("x-tc-version", "2019-09-24")
	req.Header.Set("x-tc-timestamp", fmt.Sprintf("%d", ts))
	req.Header.Set("x-tc-region", a.region)

	if err := signTC3(req, service, host, a.secretID, a.secretKey, ts, payload); err != nil {
		return nil, err
	}

	resp, err := a.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Tencent DescribeInstanceToken failed (%d): %s", resp.StatusCode, truncate(string(data), 300))
	}
	var out struct {
		Response struct {
			Username string `json:"Username"`
			Token    string `json:"Token"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	if out.Response.Username == "" || out.Response.Token == "" {
		return nil, fmt.Errorf("Tencent returned no usable token")
	}
	return &Credential{Scheme: "basic", Username: out.Response.Username, Password: out.Response.Token}, nil
}

// ---------------------------------------------------------------------------
// Signing helpers
// ---------------------------------------------------------------------------

func sha256Hex(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

func hmacSHA256(key, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(data)
	return h.Sum(nil)
}

func signV4(req *http.Request, service, region, accessKey, secretKey, amzDate, dateStamp, payloadHash string) error {
	headers := map[string]string{
		"host":       req.Host,
		"x-amz-date": amzDate,
	}
	for _, k := range []string{"x-amz-target", "content-type"} {
		if v := req.Header.Get(k); v != "" {
			headers[k] = strings.TrimSpace(v)
		}
	}
	keys := make([]string, 0, len(headers))
	for k := range headers {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var canonicalHeaders strings.Builder
	signed := make([]string, 0, len(keys))
	for _, k := range keys {
		canonicalHeaders.WriteString(k + ":" + headers[k] + "\n")
		signed = append(signed, k)
	}
	signedStr := strings.Join(signed, ";")

	uri := req.URL.EscapedPath()
	if uri == "" {
		uri = "/"
	}
	canonicalRequest := strings.Join([]string{
		req.Method, uri, req.URL.RawQuery, canonicalHeaders.String(), signedStr, payloadHash,
	}, "\n")

	scope := strings.Join([]string{dateStamp, region, service, "aws4_request"}, "/")
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256", amzDate, scope, sha256Hex([]byte(canonicalRequest)),
	}, "\n")

	kDate := hmacSHA256([]byte("AWS4"+secretKey), []byte(dateStamp))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(service))
	kSigning := hmacSHA256(kService, []byte("aws4_request"))
	signature := hex.EncodeToString(hmacSHA256(kSigning, []byte(stringToSign)))

	req.Header.Set("authorization", "AWS4-HMAC-SHA256 Credential="+accessKey+"/"+scope+
		", SignedHeaders="+signedStr+", Signature="+signature)
	return nil
}

func aliyunSignature(method string, params map[string]string, secretKey string) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var canonical strings.Builder
	for i, k := range keys {
		if i > 0 {
			canonical.WriteString("&")
		}
		canonical.WriteString(aliyunEncode(k) + "=" + aliyunEncode(params[k]))
	}
	stringToSign := method + "&" + aliyunEncode("/") + "&" + aliyunEncode(canonical.String())
	h := hmac.New(sha1.New, []byte(secretKey+"&"))
	h.Write([]byte(stringToSign))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func aliyunEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
		} else {
			b.WriteString(fmt.Sprintf("%%%02X", c))
		}
	}
	return b.String()
}

func encodeQuery(params map[string]string) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	vals := url.Values{}
	for _, k := range keys {
		vals.Set(k, params[k])
	}
	return vals.Encode()
}

func signTC3(req *http.Request, service, host, secretID, secretKey string, ts int64, payload []byte) error {
	date := time.Unix(ts, 0).UTC().Format("2006-01-02")

	canonicalHeaders := "content-type:" + req.Header.Get("content-type") + "\nhost:" + host + "\n"
	signedHeaders := "content-type;host"
	canonicalRequest := strings.Join([]string{
		req.Method, "/", "", canonicalHeaders, signedHeaders, sha256Hex(payload),
	}, "\n")

	credentialScope := date + "/" + service + "/tc3_request"
	stringToSign := strings.Join([]string{
		"TC3-HMAC-SHA256", fmt.Sprintf("%d", ts), credentialScope, sha256Hex([]byte(canonicalRequest)),
	}, "\n")

	secretDate := hmacSHA256([]byte("TC3"+secretKey), []byte(date))
	secretService := hmacSHA256(secretDate, []byte(service))
	secretSigning := hmacSHA256(secretService, []byte("tc3_request"))
	signature := hex.EncodeToString(hmacSHA256(secretSigning, []byte(stringToSign)))

	req.Header.Set("authorization", "TC3-HMAC-SHA256 Credential="+secretID+"/"+credentialScope+
		", SignedHeaders="+signedHeaders+", Signature="+signature)
	return nil
}

func nonce() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
