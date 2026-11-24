package messenger

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
	svc             *Service
	maxBodyBytes    int64
	logger          *slog.Logger
}

func NewHandler(svc *Service, maxBodyBytes int64, logger *slog.Logger) *Handler {
	if maxBodyBytes <= 0 {
		maxBodyBytes = 1 << 20
	}
	return &Handler{svc: svc, maxBodyBytes: maxBodyBytes, logger: logger}
}

// RegisterProtectedRoutes mounts authenticated channel & PushURL management APIs at /api/v1/messenger.
func (h *Handler) RegisterProtectedRoutes(r chi.Router) {
	r.Get("/drivers", httpx.Handle(h.logger, h.listDrivers))

	r.Get("/channels", httpx.Handle(h.logger, h.listChannels))
	r.Post("/channels", httpx.Handle(h.logger, h.createChannel))
	r.Put("/channels/{id}", httpx.Handle(h.logger, h.updateChannel))
	r.Delete("/channels/{id}", httpx.Handle(h.logger, h.deleteChannel))
	r.Post("/channels/{id}/test", httpx.Handle(h.logger, h.testChannel))

	r.Get("/push-endpoints", httpx.Handle(h.logger, h.listPushEndpoints))
	r.Post("/push-endpoints", httpx.Handle(h.logger, h.createPushEndpoint))
	r.Put("/push-endpoints/{id}", httpx.Handle(h.logger, h.updatePushEndpoint))
	r.Post("/push-endpoints/{id}/rotate", httpx.Handle(h.logger, h.rotatePushEndpoint))
	r.Delete("/push-endpoints/{id}", httpx.Handle(h.logger, h.deletePushEndpoint))
}

// RegisterPublicPushRoutes mounts the normalized PushURL entrypoint at /api/v1/push.
func (h *Handler) RegisterPublicPushRoutes(r chi.Router) {
	r.Get("/{token}", httpx.Handle(h.logger, h.handleNormalizedPush))
	r.Post("/{token}", httpx.Handle(h.logger, h.handleNormalizedPush))
}

// RegisterPublicWebhookRoutes mounts inbound channel webhooks at /api/v1/messenger/webhook.
func (h *Handler) RegisterPublicWebhookRoutes(r chi.Router) {
	r.Post("/{type}/{id}", httpx.Handle(h.logger, h.handleWebhook))
}

func (h *Handler) listDrivers(w http.ResponseWriter, _ *http.Request) error {
	httpx.JSON(w, http.StatusOK, map[string]any{"drivers": h.svc.Drivers()})
	return nil
}

func (h *Handler) listChannels(w http.ResponseWriter, r *http.Request) error {
	userID, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	capParam := Capability(strings.ToLower(strings.TrimSpace(r.URL.Query().Get("capability"))))
	if capParam != "" && capParam != CapOutbound && capParam != CapInbound {
		return httpx.BadRequest("capability 参数仅支持 outbound 或 inbound")
	}
	items, err := h.svc.ListChannels(r.Context(), userID, capParam)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"channels": items})
	return nil
}

func (h *Handler) createChannel(w http.ResponseWriter, r *http.Request) error {
	userID, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in UpsertChannelInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	view, err := h.svc.CreateChannel(r.Context(), userID, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"channel": view})
	return nil
}

func (h *Handler) updateChannel(w http.ResponseWriter, r *http.Request) error {
	userID, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parseIDParam(r, "id")
	if err != nil {
		return err
	}
	var in UpsertChannelInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	view, err := h.svc.UpdateChannel(r.Context(), userID, id, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"channel": view})
	return nil
}

func (h *Handler) deleteChannel(w http.ResponseWriter, r *http.Request) error {
	userID, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parseIDParam(r, "id")
	if err != nil {
		return err
	}
	if err := h.svc.DeleteChannel(r.Context(), userID, id); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

func (h *Handler) testChannel(w http.ResponseWriter, r *http.Request) error {
	userID, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parseIDParam(r, "id")
	if err != nil {
		return err
	}
	if err := h.svc.TestChannel(r.Context(), userID, id); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

func (h *Handler) listPushEndpoints(w http.ResponseWriter, r *http.Request) error {
	userID, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	items, err := h.svc.ListPushEndpoints(r.Context(), userID)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"endpoints": items})
	return nil
}

func (h *Handler) createPushEndpoint(w http.ResponseWriter, r *http.Request) error {
	userID, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in UpsertPushEndpointInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	view, err := h.svc.CreatePushEndpoint(r.Context(), userID, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"endpoint": view})
	return nil
}

func (h *Handler) updatePushEndpoint(w http.ResponseWriter, r *http.Request) error {
	userID, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parseIDParam(r, "id")
	if err != nil {
		return err
	}
	var in UpsertPushEndpointInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	view, err := h.svc.UpdatePushEndpoint(r.Context(), userID, id, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"endpoint": view})
	return nil
}

func (h *Handler) rotatePushEndpoint(w http.ResponseWriter, r *http.Request) error {
	userID, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parseIDParam(r, "id")
	if err != nil {
		return err
	}
	view, err := h.svc.RotatePushEndpointToken(r.Context(), userID, id)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"endpoint": view})
	return nil
}

func (h *Handler) deletePushEndpoint(w http.ResponseWriter, r *http.Request) error {
	userID, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parseIDParam(r, "id")
	if err != nil {
		return err
	}
	if err := h.svc.DeletePushEndpoint(r.Context(), userID, id); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

// handleNormalizedPush accepts GET query params, POST JSON, or POST Form with common field aliases.
func (h *Handler) handleNormalizedPush(w http.ResponseWriter, r *http.Request) error {
	token := chi.URLParam(r, "token")
	msg := Message{
		Title:   strings.TrimSpace(r.URL.Query().Get("title")),
		Content: firstNonEmpty(r.URL.Query().Get("content"), r.URL.Query().Get("text"), r.URL.Query().Get("body"), r.URL.Query().Get("msg")),
	}

	if r.Method == http.MethodPost {
		ct := strings.ToLower(r.Header.Get("Content-Type"))
		switch {
		case strings.Contains(ct, "application/json") || ct == "":
			if r.ContentLength != 0 {
				var body struct {
					Title   string `json:"title"`
					Content string `json:"content"`
					Text    string `json:"text"`
					Body    string `json:"body"`
					Msg     string `json:"msg"`
				}
				if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &body); err != nil {
					return err
				}
				if body.Title != "" {
					msg.Title = strings.TrimSpace(body.Title)
				}
				if c := firstNonEmpty(body.Content, body.Text, body.Body, body.Msg); c != "" {
					msg.Content = c
				}
			}
		case strings.Contains(ct, "application/x-www-form-urlencoded"):
			r.Body = http.MaxBytesReader(w, r.Body, h.maxBodyBytes)
			if err := r.ParseForm(); err != nil {
				return httpx.BadRequest("表单解析失败")
			}
			if t := strings.TrimSpace(r.PostForm.Get("title")); t != "" {
				msg.Title = t
			}
			if c := firstNonEmpty(r.PostForm.Get("content"), r.PostForm.Get("text"), r.PostForm.Get("body"), r.PostForm.Get("msg")); c != "" {
				msg.Content = c
			}
		}
	}

	results, err := h.svc.DispatchPushEndpoint(r.Context(), token, msg)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"deliveries": results,
	})
	return nil
}

func (h *Handler) handleWebhook(w http.ResponseWriter, r *http.Request) error {
	driverType := chi.URLParam(r, "type")
	id, err := parseIDParam(r, "id")
	if err != nil {
		return err
	}
	r.Body = http.MaxBytesReader(w, r.Body, h.maxBodyBytes)
	if err := h.svc.HandleWebhook(r.Context(), driverType, id, r); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

func parseIDParam(r *http.Request, name string) (int64, error) {
	raw := chi.URLParam(r, name)
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, httpx.BadRequest("无效的资源 ID")
	}
	return id, nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}
