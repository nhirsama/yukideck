package clipboard

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"yukideck/internal/core/auth"
	"yukideck/internal/core/httpx"
)

const sseHeartbeatInterval = 25 * time.Second

type Handler struct {
	svc              *Service
	maxBodyBytes     int64
	contentBodyBytes int64
	logger           *slog.Logger
}

func NewHandler(svc *Service, maxBodyBytes, clipboardMaxBytes int64, logger *slog.Logger) *Handler {
	if maxBodyBytes <= 0 {
		maxBodyBytes = 1 << 20
	}
	if clipboardMaxBytes <= 0 {
		clipboardMaxBytes = DefaultMaxBytes
	}
	// Leave headroom for JSON string escaping & envelope fields around raw UTF-8 text.
	contentBodyBytes := clipboardMaxBytes*2 + 64*1024
	if contentBodyBytes < maxBodyBytes {
		contentBodyBytes = maxBodyBytes
	}
	return &Handler{
		svc:              svc,
		maxBodyBytes:     maxBodyBytes,
		contentBodyBytes: contentBodyBytes,
		logger:           logger,
	}
}

func (h *Handler) RegisterRoutes(r chi.Router) {
	// Clipboard endpoints are OIDC session only (no API key permissions).
	r.Use(auth.RequireSession)

	r.Get("/meta", httpx.Handle(h.logger, h.getMeta))
	r.Get("/items", httpx.Handle(h.logger, h.listItems))
	r.Post("/items", httpx.Handle(h.logger, h.createItem))
	r.Post("/items/reorder", httpx.Handle(h.logger, h.reorderItems))
	r.Get("/items/{id}", httpx.Handle(h.logger, h.getItem))
	r.Put("/items/{id}", httpx.Handle(h.logger, h.updateItem))
	r.Patch("/items/{id}", httpx.Handle(h.logger, h.patchItem))
	r.Delete("/items/{id}", httpx.Handle(h.logger, h.deleteItem))
	r.Get("/events", h.streamEvents)
}

func (h *Handler) getMeta(w http.ResponseWriter, _ *http.Request) error {
	httpx.JSON(w, http.StatusOK, h.svc.Meta())
	return nil
}

func (h *Handler) listItems(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	q := r.URL.Query()
	res, err := h.svc.ListItems(r.Context(), uid, ListQuery{
		Q:           q.Get("q"),
		StarredOnly: strings.EqualFold(q.Get("starred"), "true") || q.Get("starred") == "1",
		SortBy:      q.Get("sort_by"),
		SortDir:     q.Get("sort_dir"),
	})
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
	return nil
}

func (h *Handler) getItem(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parseIDParam(r, "id")
	if err != nil {
		return err
	}
	item, err := h.svc.GetItem(r.Context(), uid, id)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, ItemResponse{Item: *item})
	return nil
}

func (h *Handler) createItem(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in CreateItemInput
	if err := httpx.DecodeJSON(w, r, h.contentBodyBytes, &in); err != nil {
		return err
	}
	item, err := h.svc.CreateItem(r.Context(), uid, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusCreated, ItemResponse{Item: *item})
	return nil
}

func (h *Handler) updateItem(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parseIDParam(r, "id")
	if err != nil {
		return err
	}
	var in UpdateItemInput
	if err := httpx.DecodeJSON(w, r, h.contentBodyBytes, &in); err != nil {
		return err
	}
	item, err := h.svc.UpdateItem(r.Context(), uid, id, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, ItemResponse{Item: *item})
	return nil
}

func (h *Handler) patchItem(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parseIDParam(r, "id")
	if err != nil {
		return err
	}
	var in PatchItemInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	item, err := h.svc.PatchItem(r.Context(), uid, id, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, ItemResponse{Item: *item})
	return nil
}

func (h *Handler) deleteItem(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parseIDParam(r, "id")
	if err != nil {
		return err
	}
	clientID := r.URL.Query().Get("client_id")
	if err := h.svc.DeleteItem(r.Context(), uid, id, clientID); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, OKResponse{OK: true})
	return nil
}

func (h *Handler) reorderItems(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in ReorderItemsInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	if err := h.svc.ReorderItems(r.Context(), uid, in); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, OKResponse{OK: true})
	return nil
}

func (h *Handler) streamEvents(w http.ResponseWriter, r *http.Request) {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		httpx.WriteError(w, r, h.logger, httpx.Unauthorized("未登录"))
		return
	}

	rc := http.NewResponseController(w)
	// Clear write deadline for long-lived SSE stream if server configured one.
	_ = rc.SetWriteDeadline(time.Time{})

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	if _, err := fmt.Fprint(w, ": connected\n\n"); err != nil {
		return
	}
	if err := rc.Flush(); err != nil {
		return
	}

	clientID := strings.TrimSpace(r.URL.Query().Get("client_id"))
	sub := h.svc.Hub().Subscribe(uid, clientID)
	defer h.svc.Hub().Unsubscribe(sub)

	ticker := time.NewTicker(sseHeartbeatInterval)
	defer ticker.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case ev, open := <-sub.ch:
			if !open {
				return
			}
			payload, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			if _, err := fmt.Fprintf(w, "event: clipboard\ndata: %s\n\n", payload); err != nil {
				return
			}
			if err := rc.Flush(); err != nil {
				return
			}
		case <-ticker.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			if err := rc.Flush(); err != nil {
				return
			}
		}
	}
}

func parseIDParam(r *http.Request, name string) (int64, error) {
	raw := chi.URLParam(r, name)
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, httpx.BadRequest("无效的条目 ID")
	}
	return id, nil
}
