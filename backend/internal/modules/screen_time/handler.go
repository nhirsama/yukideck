package screen_time

import (
	"log/slog"
	"net/http"
	"strconv"
	"strings"

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
	return &Handler{
		svc:          svc,
		maxBodyBytes: maxBodyBytes,
		logger:       logger,
	}
}

func (h *Handler) RegisterRoutes(r chi.Router) {
	readMW := auth.RequirePermission(PermissionRead, nil)

	r.With(readMW).Get("/summary", httpx.Handle(h.logger, h.getSummary))
	r.With(readMW).Get("/trends", httpx.Handle(h.logger, h.getTrends))
	r.With(readMW).Get("/heatmap", httpx.Handle(h.logger, h.getHeatmap))
	r.With(readMW).Get("/breakdowns", httpx.Handle(h.logger, h.getBreakdowns))
	r.With(readMW).Get("/hourly", httpx.Handle(h.logger, h.getHourly))
	r.With(readMW).Get("/timeline", httpx.Handle(h.logger, h.getTimeline))

	// Session-only configuration, test, visit-triggered sync, and history import endpoints
	r.Group(func(sess chi.Router) {
		sess.Use(auth.RequireSession)
		sess.Post("/sync", httpx.Handle(h.logger, h.syncOnVisit))
		sess.Get("/history-import", httpx.Handle(h.logger, h.getHistoryImportStatus))
		sess.Post("/history-import", httpx.Handle(h.logger, h.startHistoryImport))
		sess.Get("/config", httpx.Handle(h.logger, h.getConfig))
		sess.Put("/config", httpx.Handle(h.logger, h.updateConfig))
		sess.Post("/config/test", httpx.Handle(h.logger, h.testConfig))
	})
}

func resolveRequestTimezone(r *http.Request) string {
	if qtz := strings.TrimSpace(r.URL.Query().Get("tz")); qtz != "" {
		return qtz
	}
	return auth.UserTimezone(r.Context())
}

func (h *Handler) getSummary(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	q := r.URL.Query()
	res, err := h.svc.GetSummary(r.Context(), uid, resolveRequestTimezone(r), q.Get("start"), q.Get("end"))
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
	return nil
}

func (h *Handler) getTrends(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	q := r.URL.Query()
	topN := 6
	if raw := strings.TrimSpace(q.Get("top_n")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			topN = n
		}
	}
	res, err := h.svc.GetTrends(r.Context(), uid, resolveRequestTimezone(r), q.Get("start"), q.Get("end"), q.Get("granularity"), q.Get("group_by"), topN)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
	return nil
}

func (h *Handler) getHeatmap(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	year := 0
	if raw := strings.TrimSpace(r.URL.Query().Get("year")); raw != "" {
		y, err := strconv.Atoi(raw)
		if err != nil || y < 2000 || y > 2100 {
			return httpx.BadRequest("无效的 year 参数")
		}
		year = y
	}
	res, err := h.svc.GetHeatmap(r.Context(), uid, resolveRequestTimezone(r), year)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
	return nil
}

func (h *Handler) getBreakdowns(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	q := r.URL.Query()
	limit := 20
	if raw := strings.TrimSpace(q.Get("limit")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			limit = n
		}
	}
	res, err := h.svc.GetBreakdowns(r.Context(), uid, resolveRequestTimezone(r), q.Get("start"), q.Get("end"), limit)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
	return nil
}

func (h *Handler) getHourly(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	q := r.URL.Query()
	res, err := h.svc.GetHourly(r.Context(), uid, resolveRequestTimezone(r), q.Get("start"), q.Get("end"))
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
	return nil
}

func (h *Handler) getTimeline(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	res, err := h.svc.GetTimeline(r.Context(), uid, resolveRequestTimezone(r), r.URL.Query().Get("date"))
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
	return nil
}

func (h *Handler) syncOnVisit(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	tz := auth.UserTimezone(r.Context())
	disabled := auth.IsModuleDisabledForUser(r.Context(), ModuleID)
	res, err := h.svc.SyncOnVisit(r.Context(), uid, tz, disabled)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
	return nil
}

func (h *Handler) getHistoryImportStatus(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	httpx.JSON(w, http.StatusOK, h.svc.GetHistoryImportStatus(uid))
	return nil
}

func (h *Handler) startHistoryImport(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	res, err := h.svc.StartHistoryImport(r.Context(), uid, auth.UserTimezone(r.Context()))
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusAccepted, res)
	return nil
}

func (h *Handler) getConfig(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	res, err := h.svc.GetConfig(r.Context(), uid)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"config": res})
	return nil
}

func (h *Handler) updateConfig(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in UpdateConfigInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	res, err := h.svc.UpdateConfig(r.Context(), uid, auth.UserTimezone(r.Context()), in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"config": res})
	return nil
}

func (h *Handler) testConfig(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in TestConfigInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	res, err := h.svc.TestConfig(r.Context(), uid, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
	return nil
}
