package main

import (
	"context"
	"encoding/json"
	"fmt"
)

// Manifest → image layer breakdown, including the Dockerfile command that
// produced each layer and its compressed size.

func rankIndexEntries(manifests []any) []map[string]any {
	var preferred, known, unknown []map[string]any
	for _, m := range manifests {
		mm, ok := m.(map[string]any)
		if !ok {
			continue
		}
		p, _ := mm["platform"].(map[string]any)
		osName, _ := p["os"].(string)
		arch, _ := p["architecture"].(string)
		switch {
		case osName == "linux" && arch == "amd64":
			preferred = append(preferred, mm)
		case osName != "" && osName != "unknown" && arch != "" && arch != "unknown":
			known = append(known, mm)
		default:
			unknown = append(unknown, mm)
		}
	}
	return append(append(preferred, known...), unknown...)
}

type layerOut struct {
	Index     int    `json:"index"`
	Command   string `json:"command"`
	Size      int64  `json:"size"`
	Digest    string `json:"digest"`
	MediaType string `json:"mediaType"`
}

// analyzeManifest resolves a manifest (following an index if needed), reads the
// config blob and returns per-layer Dockerfile commands with their sizes.

func analyzeManifest(ctx context.Context, s *Session, repo, ref string) (any, error) {
	mr, err := s.Oci.Manifest(ctx, repo, ref)
	if err != nil {
		return nil, err
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(mr.Body), &doc); err != nil {
		return nil, fmt.Errorf("invalid manifest JSON: %w", err)
	}

	platform := map[string]any{}

	// Follow a manifest list / index down to a concrete image. Entries are tried
	// in preference order and skipped when they turn out not to be an image, so a
	// stray attestation entry can never produce an empty layer list.
	if manifests, ok := doc["manifests"].([]any); ok {
		candidates := rankIndexEntries(manifests)
		if len(candidates) == 0 {
			return nil, fmt.Errorf("manifest list is empty")
		}
		var lastErr error
		resolved := false
		for _, cand := range candidates {
			digest, _ := cand["digest"].(string)
			if digest == "" {
				continue
			}
			child, err := s.Oci.Manifest(ctx, repo, digest)
			if err != nil {
				lastErr = err
				continue
			}
			var childDoc map[string]any
			if err := json.Unmarshal([]byte(child.Body), &childDoc); err != nil {
				lastErr = err
				continue
			}
			// Attestation manifests carry no config/layers; skip them.
			if _, hasLayers := childDoc["layers"].([]any); !hasLayers {
				if _, hasConfig := childDoc["config"]; !hasConfig {
					continue
				}
			}
			doc = childDoc
			mr = child
			platform = mapFrom(cand["platform"])
			resolved = true
			break
		}
		if !resolved {
			if lastErr != nil {
				return nil, fmt.Errorf("resolving an image manifest from the manifest list failed: %w", lastErr)
			}
			return nil, fmt.Errorf("manifest list contains no image manifest")
		}
	}

	cfg, _ := doc["config"].(map[string]any)
	cfgDigest, _ := cfg["digest"].(string)
	layersRaw, _ := doc["layers"].([]any)

	var commands []string
	if cfgDigest != "" {
		if blob, err := s.Oci.Blob(ctx, repo, cfgDigest); err == nil {
			var cfgDoc map[string]any
			if json.Unmarshal(blob, &cfgDoc) == nil {
				// A single-arch manifest carries no platform of its own — only a
				// manifest list does. The config blob names it, and this read is
				// already happening, so an image without an index still reports
				// what it is instead of showing an empty pair.
				if len(platform) == 0 {
					for _, key := range []string{"os", "architecture", "variant"} {
						if v, ok := cfgDoc[key].(string); ok && v != "" {
							platform[key] = v
						}
					}
				}
				if hist, ok := cfgDoc["history"].([]any); ok {
					for _, h := range hist {
						hm, ok := h.(map[string]any)
						if !ok {
							continue
						}
						if empty, _ := hm["empty_layer"].(bool); empty {
							continue
						}
						cb, _ := hm["created_by"].(string)
						commands = append(commands, cb)
					}
				}
			}
		}
	}

	layers := []layerOut{}
	var total int64
	for i, l := range layersRaw {
		lm, ok := l.(map[string]any)
		if !ok {
			continue
		}
		size, _ := lm["size"].(float64)
		digest, _ := lm["digest"].(string)
		mediaType, _ := lm["mediaType"].(string)
		cmd := ""
		if i < len(commands) {
			cmd = commands[i]
		}
		layers = append(layers, layerOut{Index: i + 1, Command: cmd, Size: int64(size), Digest: digest, MediaType: mediaType})
		total += int64(size)
	}

	return map[string]any{
		"digest":    mr.Digest,
		"mediaType": mr.MediaType,
		"platform":  platform,
		"layers":    layers,
		"totalSize": total,
	}, nil
}

func mapFrom(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}
