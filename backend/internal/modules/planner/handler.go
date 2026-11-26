package planner

import (
	"log/slog"
	"net/http"
	"strconv"
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
	readMW := auth.RequirePermission(PermissionRead, nil)
	writeMW := auth.RequirePermission(PermissionWrite, nil)

	r.With(readMW).Get("/items", httpx.Handle(h.logger, h.listItems))
	r.With(writeMW).Post("/items", httpx.Handle(h.logger, h.createItem))
	r.With(writeMW).Put("/items/{id}", httpx.Handle(h.logger, h.updateItem))
	r.With(writeMW).Delete("/items/{id}", httpx.Handle(h.logger, h.deleteItem))
	r.With(writeMW).Post("/items/{id}/complete", httpx.Handle(h.logger, h.completeItem))
	r.With(writeMW).Post("/items/{id}/reopen", httpx.Handle(h.logger, h.reopenItem))
	r.With(writeMW).Post("/items/{id}/pause", httpx.Handle(h.logger, h.pauseItem))
	r.With(writeMW).Post("/items/{id}/resume", httpx.Handle(h.logger, h.resumeItem))
	r.With(writeMW).Post("/items/{id}/test", httpx.Handle(h.logger, h.testItem))

	r.With(readMW).Get("/calendar", httpx.Handle(h.logger, h.listCalendar))
	r.With(readMW).Get("/logs", httpx.Handle(h.logger, h.listLogs))
}

func (h *Handler) listItems(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	items, err := h.svc.ListItems(r.Context(), uid)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
	return nil
}

func (h *Handler) createItem(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in UpsertItemInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	item, err := h.svc.CreateItem(r.Context(), uid, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"item": item})
	return nil
}

func (h *Handler) updateItem(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parseID(r)
	if err != nil {
		return err
	}
	var in UpsertItemInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	item, err := h.svc.UpdateItem(r.Context(), uid, id, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"item": item})
	return nil
}

func (h *Handler) deleteItem(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parseID(r)
	if err != nil {
		return err
	}
	if err := h.svc.DeleteItem(r.Context(), uid, id); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

func (h *Handler) completeItem(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parseID(r)
	if err != nil {
		return err
	}
	item, err := h.svc.CompleteItem(r.Context(), uid, id)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"item": item})
	return nil
}

func (h *Handler) reopenItem(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parseID(r)
	if err != nil {
		return err
	}
	item, err := h.svc.ReopenItem(r.Context(), uid, id)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"item": item})
	return nil
}

func (h *Handler) pauseItem(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parseID(r)
	if err != nil {
		return err
	}
	var in PauseItemInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	item, err := h.svc.PauseItem(r.Context(), uid, id, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"item": item})
	return nil
}

func (h *Handler) resumeItem(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parseID(r)
	if err != nil {
		return err
	}
	item, err := h.svc.ResumeItem(r.Context(), uid, id)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"item": item})
	return nil
}

func (h *Handler) testItem(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parseID(r)
	if err != nil {
		return err
	}
	if err := h.svc.TestItem(r.Context(), uid, id); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

func (h *Handler) listCalendar(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	start, err := parseQueryTime(r.URL.Query().Get("start"), time.Now().AddDate(0, -1, 0))
	if err != nil {
		return httpx.BadRequest("无效的 start 参数")
	}
	end, err := parseQueryTime(r.URL.Query().Get("end"), time.Now().AddDate(0, 2, 0))
	if err != nil {
		return httpx.BadRequest("无效的 end 参数")
	}
	events, err := h.svc.ListCalendarEvents(r.Context(), uid, start, end)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"events": events})
	return nil
}

func (h *Handler) listLogs(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	status := r.URL.Query().Get("status")
	limit := maxLogsPerUser
	if rawLimit := r.URL.Query().Get("limit"); rawLimit != "" {
		if n, err := strconv.Atoi(rawLimit); err == nil && n > 0 {
			limit = n
		}
	}
	logs, err := h.svc.ListLogs(r.Context(), uid, status, limit)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"logs": logs})
	return nil
}

func parseID(r *http.Request) (int64, error) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		return 0, httpx.BadRequest("无效的事项 ID")
	}
	return id, nil
}

func parseQueryTime(raw string, fallback time.Time) (time.Time, error) {
	if raw == "" {
		return fallback, nil
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t, nil
	}
	if t, err := time.Parse("2006-01-02", raw); err == nil {
		return t, nil
	}
	return time.Time{}, httpx.BadRequest("时间格式无效")
}
