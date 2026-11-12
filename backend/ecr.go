package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// AWS ECR private registry
//
// ECR speaks OCI Distribution for pull/push, but it does not implement
// GET /v2/_catalog. The repository list therefore comes from the ECR API's
// DescribeRepositories, signed with the same credentials as
// GetAuthorizationToken. Everything else (tags, manifests, blobs) continues
// through the standard /v2/ client.
//
// The endpoint overrides are for the local end-to-end suite: the test points
// both ECR API calls at an HTTP fixture instead of AWS. They are read from the
// sidecar's environment and never from connection data.
// ---------------------------------------------------------------------------

func ecrTokenEndpoint(region string) string {
	if endpoint := strings.TrimSpace(os.Getenv("IMREPO_ECR_TOKEN_ENDPOINT")); endpoint != "" {
		return endpoint
	}
	return "https://ecr." + region + ".amazonaws.com/"
}

func ecrAPIEndpoint(region string) string {
	if endpoint := strings.TrimSpace(os.Getenv("IMREPO_ECR_API_ENDPOINT")); endpoint != "" {
		return endpoint
	}
	return "https://api.ecr." + region + ".amazonaws.com/"
}

// DescribeRepositories lists every private repository visible to the IAM
// principal. ECR pages at 1000 entries; the loop is bounded so a broken
// nextToken cannot spin forever.
func (a *awsEcrAuth) DescribeRepositories(ctx context.Context) ([]string, error) {
	if a == nil {
		return nil, fmt.Errorf("AWS ECR credentials are not available")
	}
	if strings.TrimSpace(a.region) == "" {
		return nil, fmt.Errorf("AWS ECR region is required")
	}
	const target = "AmazonEC2ContainerRegistry_V20150921.DescribeRepositories"
	const maxPages = 100
	var names []string
	nextToken := ""
	for page := 0; page < maxPages; page++ {
		payload := map[string]any{"maxResults": 1000}
		if nextToken != "" {
			payload["nextToken"] = nextToken
		}
		body, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, ecrAPIEndpoint(a.region), bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("content-type", "application/x-amz-json-1.1")
		req.Header.Set("x-amz-target", target)
		req.Host = req.URL.Host
		now := time.Now().UTC()
		amzDate := now.Format("20060102T150405Z")
		dateStamp := now.Format("20060102")
		req.Header.Set("x-amz-date", amzDate)
		if err := signV4(req, "ecr", a.region, a.accessKey, a.secretKey, a.sessionToken,
			amzDate, dateStamp, sha256Hex(body)); err != nil {
			return nil, err
		}
		resp, err := a.http.Do(req)
		if err != nil {
			return nil, err
		}
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			msg := truncate(string(data), 300)
			switch resp.StatusCode {
			case http.StatusForbidden, http.StatusUnauthorized:
				return nil, fmt.Errorf("ecr:DescribeRepositories was refused (%d): %s — the IAM principal needs ecr:DescribeRepositories", resp.StatusCode, msg)
			case http.StatusBadRequest:
				return nil, fmt.Errorf("ecr:DescribeRepositories was rejected (%d): %s — check the region and ecr:DescribeRepositories permission", resp.StatusCode, msg)
			default:
				return nil, fmt.Errorf("ecr:DescribeRepositories failed (%d): %s", resp.StatusCode, msg)
			}
		}
		var out struct {
			Repositories []struct {
				RepositoryName string `json:"repositoryName"`
			} `json:"repositories"`
			NextToken string `json:"nextToken"`
		}
		if err := json.Unmarshal(data, &out); err != nil {
			return nil, fmt.Errorf("ecr:DescribeRepositories returned invalid JSON: %w", err)
		}
		for _, repository := range out.Repositories {
			if name := strings.TrimSpace(repository.RepositoryName); name != "" {
				names = append(names, name)
			}
		}
		if out.NextToken == "" || out.NextToken == nextToken {
			break
		}
		nextToken = out.NextToken
	}
	sort.Strings(names)
	return names, nil
}
