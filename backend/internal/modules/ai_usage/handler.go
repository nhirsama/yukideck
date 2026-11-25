package ai_usage

import (
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"yukideck/internal/core/auth"
	"yukideck/internal/core/httpx"
)

type Handler struct {
	svc          *Service
	maxBodyBytes int64
	logger       *slog.Logger
}

func NewHandler(svc *Service, maxBodyBytes int64, logger *slog.Logger) *Handler {
	if maxBodyBytes <= 0 {
		maxBodyBytes = 1 << 20
	}
	return &Handler{svc: svc, maxBodyBytes: maxBodyBytes, logger: logger}
}

func (h *Handler) RegisterRoutes(r chi.Router) {
	ingestMW := auth.RequirePermission(PermissionIngest, nil)
	readMW := auth.RequirePermission(PermissionRead, nil)

	r.With(ingestMW).Post("/ingest", httpx.Handle(h.logger, h.ingest))

	r.With(readMW).Get("/summary", httpx.Handle(h.logger, h.summary))
	r.With(readMW).Get("/trends", httpx.Handle(h.logger, h.trends))
	r.With(readMW).Get("/heatmap", httpx.Handle(h.logger, h.heatmap))
	r.With(readMW).Get("/sessions", httpx.Handle(h.logger, h.sessions))
	r.With(readMW).Get("/sessions/{session_id}", httpx.Handle(h.logger, h.sessionDetail))
	r.With(readMW).Get("/tools", httpx.Handle(h.logger, h.tools))

	// Device, model alias and pricing management stay OIDC session only.
	r.Group(func(sess chi.Router) {
		sess.Use(auth.RequireSession)

		sess.Get("/devices", httpx.Handle(h.logger, h.listDevices))
		sess.Put("/devices/{device_id}", httpx.Handle(h.logger, h.updateDevice))
		sess.Delete("/devices/{device_id}", httpx.Handle(h.logger, h.deleteDevice))

		sess.Get("/aliases", httpx.Handle(h.logger, h.listAliases))
		sess.Put("/aliases", httpx.Handle(h.logger, h.upsertAlias))
		sess.Delete("/aliases/{id}", httpx.Handle(h.logger, h.deleteAlias))

		sess.Get("/prices", httpx.Handle(h.logger, h.listPrices))
		sess.Put("/prices", httpx.Handle(h.logger, h.upsertPrice))
		sess.Delete("/prices/{id}", httpx.Handle(h.logger, h.deletePrice))
	})
}

func (h *Handler) ingest(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}

	var req IngestRequest
	if err := decodeIngestJSON(w, r, MaxIngestBodyBytes, &req); err != nil {
		return err
	}
	res, err := h.svc.Ingest(r.Context(), uid, req)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
	return nil
}

func (h *Handler) summary(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	filter, err := parseQueryFilter(r, 30)
	if err != nil {
		return err
	}
	res, err := h.svc.Summary(r.Context(), uid, filter)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
	return nil
}

func (h *Handler) trends(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	filter, err := parseQueryFilter(r, 30)
	if err != nil {
		return err
	}
	q := r.URL.Query()
	res, err := h.svc.Trends(r.Context(), uid, filter, q.Get("granularity"), q.Get("group_by"))
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
	return nil
}

func (h *Handler) heatmap(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	filter, err := parseQueryFilter(r, 365)
	if err != nil {
		return err
	}
	res, err := h.svc.Heatmap(r.Context(), uid, filter)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
	return nil
}

func (h *Handler) sessions(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	filter, err := parseQueryFilter(r, 30)
	if err != nil {
		return err
	}
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	pageSize, _ := strconv.Atoi(q.Get("page_size"))
	res, err := h.svc.Sessions(r.Context(), uid, filter, page, pageSize)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
	return nil
}

func (h *Handler) sessionDetail(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	sessionID := chi.URLParam(r, "session_id")
	deviceID := r.URL.Query().Get("device_id")
	res, err := h.svc.SessionDetail(r.Context(), uid, sessionID, deviceID)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
	return nil
}

func (h *Handler) tools(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	filter, err := parseQueryFilter(r, 30)
	if err != nil {
		return err
	}
	res, err := h.svc.Tools(r.Context(), uid, filter)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
	return nil
}

func (h *Handler) listDevices(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	devices, err := h.svc.ListDevices(r.Context(), uid)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"devices": devices})
	return nil
}

func (h *Handler) updateDevice(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in UpdateDeviceInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	dev, err := h.svc.UpdateDevice(r.Context(), uid, chi.URLParam(r, "device_id"), in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"device": dev})
	return nil
}

func (h *Handler) deleteDevice(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	if err := h.svc.DeleteDevice(r.Context(), uid, chi.URLParam(r, "device_id")); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

func (h *Handler) listAliases(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	aliases, err := h.svc.ListModelAliases(r.Context(), uid)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"aliases": aliases})
	return nil
}

func (h *Handler) upsertAlias(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in UpsertModelAliasInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	alias, err := h.svc.UpsertModelAlias(r.Context(), uid, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"alias": alias})
	return nil
}

func (h *Handler) deleteAlias(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		return httpx.BadRequest("无效的别名 ID")
	}
	if err := h.svc.DeleteModelAlias(r.Context(), uid, id); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

func (h *Handler) listPrices(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	res, err := h.svc.ListPrices(r.Context(), uid)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
	return nil
}

func (h *Handler) upsertPrice(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in UpsertModelPriceInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	price, err := h.svc.UpsertModelPrice(r.Context(), uid, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"price": price})
	return nil
}

func (h *Handler) deletePrice(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		return httpx.BadRequest("无效的单价 ID")
	}
	if err := h.svc.DeleteModelPrice(r.Context(), uid, id); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

func decodeIngestJSON(w http.ResponseWriter, r *http.Request, maxUncompressedBytes int64, dst any) error {
	if r.ContentLength > maxUncompressedBytes {
		return httpx.PayloadTooLarge("上报请求体超出服务器上限")
	}
	var src io.Reader = http.MaxBytesReader(w, r.Body, maxUncompressedBytes)
	if strings.EqualFold(strings.TrimSpace(r.Header.Get("Content-Encoding")), "gzip") {
		gz, err := gzip.NewReader(src)
		if err != nil {
			return httpx.BadRequest("无效的 gzip 压缩请求体")
		}
		defer gz.Close()
		src = io.LimitReader(gz, maxUncompressedBytes+1)
	}
	raw, err := io.ReadAll(src)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return httpx.PayloadTooLarge("上报请求体超出服务器上限")
		}
		return httpx.BadRequest("读取请求体失败")
	}
	if int64(len(raw)) > maxUncompressedBytes {
		return httpx.PayloadTooLarge("解压后请求体超出服务器上限")
	}
	if len(raw) == 0 {
		return httpx.BadRequest("请求体不能为空")
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return httpx.BadRequest("JSON 格式无效: " + err.Error())
	}
	return nil
}

func parseQueryFilter(r *http.Request, defaultDays int) (QueryFilter, error) {
	q := r.URL.Query()
	tz := strings.TrimSpace(q.Get("tz"))
	if tz == "" {
		tz = "UTC"
	}
	loc := loadTimezone(tz)

	now := time.Now().In(loc)
	defaultEnd := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, loc).UTC()
	defaultStart := defaultEnd.AddDate(0, 0, -defaultDays)

	start, err := parseTimeParam(q.Get("start"), defaultStart, loc, false)
	if err != nil {
		return QueryFilter{}, httpx.BadRequest("无效的 start 参数")
	}
	end, err := parseTimeParam(q.Get("end"), defaultEnd, loc, true)
	if err != nil {
		return QueryFilter{}, httpx.BadRequest("无效的 end 参数")
	}
	if !end.After(start) {
		return QueryFilter{}, httpx.BadRequest("end 必须晚于 start")
	}

	return QueryFilter{
		Start:         start,
		End:           end,
		Timezone:      tz,
		Agent:         q.Get("agent"),
		Model:         q.Get("model"),
		DeviceID:      q.Get("device_id"),
		Project:       q.Get("project"),
		IncludeHidden: strings.EqualFold(q.Get("include_hidden"), "true"),
	}, nil
}

func parseTimeParam(raw string, fallback time.Time, loc *time.Location, endExclusive bool) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback, nil
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t.UTC(), nil
	}
	if t, err := time.ParseInLocation("2006-01-02", raw, loc); err == nil {
		if endExclusive {
			return t.AddDate(0, 0, 1).UTC(), nil
		}
		return t.UTC(), nil
	}
	return time.Time{}, errors.New("invalid time")
}
