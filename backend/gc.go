package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// Garbage collection: Harbor's own registry GC, as opposed to the untagged
// cleanup in cleanup.go, which deletes artifacts through the API. GC is what
// actually reclaims the blobs those deletions orphan.
//
// Harbor exposes one resource for this, /api/v2.0/system/gc/schedule, with three
// verbs — read it, create it, replace it — plus the "Manual" schedule type,
// which runs once immediately. The request body is a wrapper, not the schedule
// itself:
//
//	{"schedule": {"type": "Daily", "cron": "0 0 0 * * *"},
//	 "parameters": {"delete_untagged": true, "workers": 1}}
//
// The swagger declares the body as a bare `Schedule`; the handler reads
// `params.Schedule.Schedule` and `params.Schedule.Parameters`, which is the
// wrapper above (src/server/v2.0/handler/gc.go). Worth stating because the
// swagger alone points the wrong way.
//
// Creating and updating are separate verbs, so a write has to know whether a
// schedule already exists — and only the update carries the id, which a delete
// or a later update needs.

// gcSchedulePath is the single endpoint for reading and writing the schedule.
const gcSchedulePath = "/api/v2.0/system/gc/schedule"

// gcScheduleTypes are the values Harbor accepts in schedule.type. "Manual" is
// not a schedule at all — it runs once and leaves the schedule in place.
var gcScheduleTypes = map[string]bool{
	"Hourly": true, "Daily": true, "Weekly": true,
	"Custom": true, "Manual": true, "None": true,
}

// gcParameters are passed through to Harbor; only the ones it understands are
// forwarded, so a stray key cannot make the whole request invalid.
var gcParameterKeys = []string{"delete_untagged", "delete_tag", "dry_run", "workers"}

func gcParams(params map[string]any) map[string]any {
	out := map[string]any{}
	for _, key := range gcParameterKeys {
		if v, ok := params[key]; ok && v != nil {
			out[key] = v
		}
	}
	return out
}

func gcBody(params map[string]any) (map[string]any, error) {
	scheduleType := strings.TrimSpace(strParam(params, "scheduleType"))
	if scheduleType == "" {
		return nil, errors.New("scheduleType is required")
	}
	if !gcScheduleTypes[scheduleType] {
		return nil, fmt.Errorf("unknown schedule type %q", scheduleType)
	}
	schedule := map[string]any{"type": scheduleType}
	if cron := strings.TrimSpace(strParam(params, "cron")); cron != "" {
		schedule["cron"] = cron
	}
	if scheduleType == "Custom" && schedule["cron"] == nil {
		return nil, errors.New("a Custom schedule needs a cron expression")
	}
	// The id identifies an existing schedule for an update; Harbor rejects an
	// update that does not carry it.
	if id := intParam(params, "scheduleId"); id > 0 {
		schedule["id"] = id
	}
	return map[string]any{"schedule": schedule, "parameters": gcParams(params)}, nil
}

// gcGet reads the current schedule, if there is one.
//
// A 404 is the ordinary "nothing scheduled" answer rather than an error: Harbor
// returns it when GC has never been configured, and the panel has to be able to
// say that instead of showing a failure.
func gcGet(ctx context.Context, s *Session) (any, error) {
	if err := requireHarbor(s); err != nil {
		return nil, err
	}
	data, code, err := s.Harbor.do(ctx, http.MethodGet, gcSchedulePath)
	if err != nil {
		return nil, err
	}
	if code == http.StatusNotFound {
		return map[string]any{"configured": false}, nil
	}
	if code != http.StatusOK {
		return nil, mgmtErr("reading the GC schedule", code, data, nil)
	}

	var raw struct {
		ID            int64  `json:"id"`
		JobKind       string `json:"job_kind"`
		JobParameters string `json:"job_parameters"`
		JobStatus     string `json:"job_status"`
		CreationTime  string `json:"creation_time"`
		UpdateTime    string `json:"update_time"`
		Schedule      struct {
			Type              string `json:"type"`
			Cron              string `json:"cron"`
			NextScheduledTime string `json:"next_scheduled_time"`
		} `json:"schedule"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("unexpected GC schedule payload: %w", err)
	}

	// job_parameters arrives as a JSON string inside JSON, not an object.
	parameters := map[string]any{}
	if raw.JobParameters != "" {
		_ = json.Unmarshal([]byte(raw.JobParameters), &parameters)
	}
	return map[string]any{
		"configured":      true,
		"id":              raw.ID,
		"type":            raw.Schedule.Type,
		"cron":            raw.Schedule.Cron,
		"nextScheduledAt": raw.Schedule.NextScheduledTime,
		"lastStatus":      raw.JobStatus,
		"createdAt":       raw.CreationTime,
		"updatedAt":       raw.UpdateTime,
		"parameters":      parameters,
	}, nil
}

// gcSet creates or replaces the schedule. Harbor has separate verbs and the
// create verb rejects a body carrying an id, so which one to use is decided by
// whether a schedule exists right now — read, then write, rather than asking the
// caller to say.
func gcSet(ctx context.Context, s *Session, params map[string]any) (any, error) {
	if err := requireHarbor(s); err != nil {
		return nil, err
	}
	body, err := gcBody(params)
	if err != nil {
		return nil, err
	}

	existing, err := gcGet(ctx, s)
	if err != nil {
		return nil, err
	}
	current, _ := existing.(map[string]any)
	exists, _ := current["configured"].(bool)

	verb := http.MethodPost
	if exists {
		verb = http.MethodPut
		// The update needs the id, and the caller does not have to know it.
		if id, _ := current["id"].(float64); id > 0 {
			if sch, ok := body["schedule"].(map[string]any); ok && sch["id"] == nil {
				sch["id"] = int64(id)
			}
		}
	}

	data, code, err := s.Harbor.doBody(ctx, verb, gcSchedulePath, body)
	if err != nil {
		return nil, err
	}
	if code != http.StatusCreated && code != http.StatusOK && code != http.StatusNoContent {
		return nil, mgmtErr("saving the GC schedule", code, data, nil)
	}
	verbWord := "created"
	if exists {
		verbWord = "updated"
	}
	return map[string]any{"ok": true, "message": "GC schedule " + verbWord}, nil
}

// gcTrigger runs GC once, now.
//
// Harbor models a manual run as a schedule of type "Manual" — posting it starts
// the job immediately and leaves any existing schedule in place (the handler
// branches to a one-off policy; see gcAPI.kick). Deleting artifacts is not what
// this does: GC reclaims blobs that earlier deletions orphaned, which is why a
// manual run is safe to offer next to the ordinary schedule controls.
func gcTrigger(ctx context.Context, s *Session, params map[string]any) (any, error) {
	if err := requireHarbor(s); err != nil {
		return nil, err
	}
	body := map[string]any{
		"schedule":   map[string]any{"type": "Manual"},
		"parameters": gcParams(params),
	}
	data, code, err := s.Harbor.doBody(ctx, http.MethodPost, gcSchedulePath, body)
	if err != nil {
		return nil, err
	}
	if code != http.StatusCreated && code != http.StatusOK {
		return nil, mgmtErr("starting a manual GC run", code, data, nil)
	}
	return map[string]any{"ok": true, "message": "GC started"}, nil
}
