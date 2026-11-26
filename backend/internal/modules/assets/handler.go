package assets

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
	return &Handler{svc: svc, maxBodyBytes: maxBodyBytes, logger: logger}
}

func (h *Handler) RegisterRoutes(r chi.Router) {
	// Assets endpoints are OIDC session only (no API key permissions in v1).
	r.Use(auth.RequireSession)

	r.Get("/meta", httpx.Handle(h.logger, h.getMeta))
	r.Put("/settings", httpx.Handle(h.logger, h.updateSettings))
	r.Get("/rates", httpx.Handle(h.logger, h.getRates))

	r.Post("/categories", httpx.Handle(h.logger, h.createCategory))
	r.Put("/categories/{id}", httpx.Handle(h.logger, h.updateCategory))
	r.Delete("/categories/{id}", httpx.Handle(h.logger, h.deleteCategory))
	r.Post("/categories/reorder", httpx.Handle(h.logger, h.reorderCategories))

	r.Post("/tags", httpx.Handle(h.logger, h.createTag))
	r.Put("/tags/{id}", httpx.Handle(h.logger, h.updateTag))
	r.Delete("/tags/{id}", httpx.Handle(h.logger, h.deleteTag))

	r.Post("/channels", httpx.Handle(h.logger, h.createChannel))
	r.Put("/channels/{id}", httpx.Handle(h.logger, h.updateChannel))
	r.Delete("/channels/{id}", httpx.Handle(h.logger, h.deleteChannel))

	r.Post("/locations", httpx.Handle(h.logger, h.createLocation))
	r.Put("/locations/{id}", httpx.Handle(h.logger, h.updateLocation))
	r.Delete("/locations/{id}", httpx.Handle(h.logger, h.deleteLocation))

	r.Get("/items", httpx.Handle(h.logger, h.listItems))
	r.Post("/items", httpx.Handle(h.logger, h.createItem))
	r.Post("/items/reorder", httpx.Handle(h.logger, h.reorderItems))
	r.Post("/items/batch", httpx.Handle(h.logger, h.batchItems))
	r.Get("/items/{id}", httpx.Handle(h.logger, h.getItemDetail))
	r.Put("/items/{id}", httpx.Handle(h.logger, h.updateItem))
	r.Delete("/items/{id}", httpx.Handle(h.logger, h.deleteItem))
	r.Post("/items/{id}/use", httpx.Handle(h.logger, h.useItem))
	r.Post("/items/{id}/retire", httpx.Handle(h.logger, h.retireItem))
	r.Post("/items/{id}/unretire", httpx.Handle(h.logger, h.unretireItem))

	r.Post("/items/{id}/transactions", httpx.Handle(h.logger, h.createTransaction))
	r.Put("/items/{id}/transactions/{tx_id}", httpx.Handle(h.logger, h.updateTransaction))
	r.Delete("/items/{id}/transactions/{tx_id}", httpx.Handle(h.logger, h.deleteTransaction))
}

func (h *Handler) getMeta(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	res, err := h.svc.GetMeta(r.Context(), uid)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
	return nil
}

func (h *Handler) updateSettings(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in UpdateSettingsInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	settings, err := h.svc.UpdateSettings(r.Context(), uid, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"settings": settings})
	return nil
}

func (h *Handler) getRates(w http.ResponseWriter, r *http.Request) error {
	if _, ok := auth.UserID(r.Context()); !ok {
		return httpx.Unauthorized("未登录")
	}
	refresh := r.URL.Query().Get("refresh") == "true" || r.URL.Query().Get("refresh") == "1"
	rates := h.svc.GetRates(r.Context(), refresh)
	httpx.JSON(w, http.StatusOK, map[string]any{"rates": rates})
	return nil
}

// --- Categories ---

func (h *Handler) createCategory(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in UpsertCategoryInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	cat, err := h.svc.CreateCategory(r.Context(), uid, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"category": cat})
	return nil
}

func (h *Handler) updateCategory(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parsePathID(r, "id")
	if err != nil {
		return err
	}
	var in UpsertCategoryInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	cat, err := h.svc.UpdateCategory(r.Context(), uid, id, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"category": cat})
	return nil
}

func (h *Handler) deleteCategory(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parsePathID(r, "id")
	if err != nil {
		return err
	}
	if err := h.svc.DeleteCategory(r.Context(), uid, id); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

func (h *Handler) reorderCategories(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in ReorderInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	if err := h.svc.ReorderCategories(r.Context(), uid, in.IDs); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

// --- Tags / Channels / Locations ---

func (h *Handler) createTag(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in UpsertTagInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	tag, err := h.svc.CreateTag(r.Context(), uid, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"tag": tag})
	return nil
}

func (h *Handler) updateTag(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parsePathID(r, "id")
	if err != nil {
		return err
	}
	var in UpsertTagInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	tag, err := h.svc.UpdateTag(r.Context(), uid, id, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"tag": tag})
	return nil
}

func (h *Handler) deleteTag(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parsePathID(r, "id")
	if err != nil {
		return err
	}
	if err := h.svc.DeleteTag(r.Context(), uid, id); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

func (h *Handler) createChannel(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in UpsertChannelInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	ch, err := h.svc.CreateChannel(r.Context(), uid, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"channel": ch})
	return nil
}

func (h *Handler) updateChannel(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parsePathID(r, "id")
	if err != nil {
		return err
	}
	var in UpsertChannelInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	ch, err := h.svc.UpdateChannel(r.Context(), uid, id, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"channel": ch})
	return nil
}

func (h *Handler) deleteChannel(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parsePathID(r, "id")
	if err != nil {
		return err
	}
	if err := h.svc.DeleteChannel(r.Context(), uid, id); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

func (h *Handler) createLocation(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in UpsertLocationInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	loc, err := h.svc.CreateLocation(r.Context(), uid, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"location": loc})
	return nil
}

func (h *Handler) updateLocation(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parsePathID(r, "id")
	if err != nil {
		return err
	}
	var in UpsertLocationInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	loc, err := h.svc.UpdateLocation(r.Context(), uid, id, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"location": loc})
	return nil
}

func (h *Handler) deleteLocation(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parsePathID(r, "id")
	if err != nil {
		return err
	}
	if err := h.svc.DeleteLocation(r.Context(), uid, id); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

// --- Items ---

func (h *Handler) listItems(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	q := r.URL.Query()
	filter := ItemListFilter{
		Today:          q.Get("today"),
		Currency:       q.Get("currency"),
		Query:          q.Get("q"),
		Status:         q.Get("status"),
		RetireReason:   q.Get("retire_reason"),
		PurchasedFrom:  q.Get("purchased_from"),
		PurchasedTo:    q.Get("purchased_to"),
		WarrantyStatus: q.Get("warranty_status"),
		TagMode:        q.Get("tag_mode"),
		SortBy:         q.Get("sort_by"),
		SortDir:        q.Get("sort_dir"),
		ExactCategory:  q.Get("exact_category") == "true" || q.Get("exact_category") == "1",
	}

	if raw := strings.TrimSpace(q.Get("exclude_retired")); raw != "" {
		b := raw == "true" || raw == "1"
		filter.ExcludeRetired = &b
	}
	if raw := strings.TrimSpace(q.Get("category_id")); raw != "" {
		if raw == "uncategorized" {
			filter.Uncategorized = true
		} else {
			cid, err := strconv.ParseInt(raw, 10, 64)
			if err != nil || cid <= 0 {
				return httpx.BadRequest("无效的 category_id")
			}
			filter.CategoryID = &cid
		}
	}

	var err error
	if filter.MinPrice, err = parseOptionalFloat(q.Get("min_price"), "min_price"); err != nil {
		return err
	}
	if filter.MaxPrice, err = parseOptionalFloat(q.Get("max_price"), "max_price"); err != nil {
		return err
	}
	if filter.MinDailyCost, err = parseOptionalFloat(q.Get("min_daily_cost"), "min_daily_cost"); err != nil {
		return err
	}
	if filter.MaxDailyCost, err = parseOptionalFloat(q.Get("max_daily_cost"), "max_daily_cost"); err != nil {
		return err
	}
	if filter.MinHoldingDays, err = parseOptionalInt(q.Get("min_holding_days"), "min_holding_days"); err != nil {
		return err
	}
	if filter.MaxHoldingDays, err = parseOptionalInt(q.Get("max_holding_days"), "max_holding_days"); err != nil {
		return err
	}
	if filter.MinUsageCount, err = parseOptionalInt(q.Get("min_usage_count"), "min_usage_count"); err != nil {
		return err
	}
	if filter.MaxUsageCount, err = parseOptionalInt(q.Get("max_usage_count"), "max_usage_count"); err != nil {
		return err
	}
	if rawTags := strings.TrimSpace(q.Get("tag_ids")); rawTags != "" {
		for _, part := range strings.Split(rawTags, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			tid, err := strconv.ParseInt(part, 10, 64)
			if err != nil || tid <= 0 {
				return httpx.BadRequest("无效的 tag_ids 参数")
			}
			filter.TagIDs = append(filter.TagIDs, tid)
		}
	}

	res, err := h.svc.ListItems(r.Context(), uid, filter)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
	return nil
}

func (h *Handler) getItemDetail(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parsePathID(r, "id")
	if err != nil {
		return err
	}
	res, err := h.svc.GetItemDetail(r.Context(), uid, id, r.URL.Query().Get("today"), r.URL.Query().Get("currency"))
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
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
	item, err := h.svc.CreateItem(r.Context(), uid, in, r.URL.Query().Get("today"))
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
	id, err := parsePathID(r, "id")
	if err != nil {
		return err
	}
	var in UpsertItemInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	item, err := h.svc.UpdateItem(r.Context(), uid, id, in, r.URL.Query().Get("today"))
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
	id, err := parsePathID(r, "id")
	if err != nil {
		return err
	}
	if err := h.svc.DeleteItem(r.Context(), uid, id); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

func (h *Handler) useItem(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parsePathID(r, "id")
	if err != nil {
		return err
	}
	in := UseItemInput{Delta: 1}
	if r.ContentLength > 0 {
		if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
			return err
		}
	}
	item, err := h.svc.UseItem(r.Context(), uid, id, in.Delta, r.URL.Query().Get("today"))
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"item": item})
	return nil
}

func (h *Handler) retireItem(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parsePathID(r, "id")
	if err != nil {
		return err
	}
	var in RetireItemInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	item, err := h.svc.RetireItem(r.Context(), uid, id, in, r.URL.Query().Get("today"))
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"item": item})
	return nil
}

func (h *Handler) unretireItem(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	id, err := parsePathID(r, "id")
	if err != nil {
		return err
	}
	item, err := h.svc.UnretireItem(r.Context(), uid, id, r.URL.Query().Get("today"))
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"item": item})
	return nil
}

func (h *Handler) reorderItems(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in ReorderInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	if err := h.svc.ReorderItems(r.Context(), uid, in.IDs); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

func (h *Handler) batchItems(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in BatchItemInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	affected, err := h.svc.BatchItems(r.Context(), uid, in, r.URL.Query().Get("today"))
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "affected": affected})
	return nil
}

// --- Transactions ---

func (h *Handler) createTransaction(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	itemID, err := parsePathID(r, "id")
	if err != nil {
		return err
	}
	var in UpsertTransactionInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	tx, err := h.svc.CreateTransaction(r.Context(), uid, itemID, in, r.URL.Query().Get("today"))
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"transaction": tx})
	return nil
}

func (h *Handler) updateTransaction(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	itemID, err := parsePathID(r, "id")
	if err != nil {
		return err
	}
	txID, err := parsePathID(r, "tx_id")
	if err != nil {
		return err
	}
	var in UpsertTransactionInput
	if err := httpx.DecodeJSON(w, r, h.maxBodyBytes, &in); err != nil {
		return err
	}
	tx, err := h.svc.UpdateTransaction(r.Context(), uid, itemID, txID, in, r.URL.Query().Get("today"))
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"transaction": tx})
	return nil
}

func (h *Handler) deleteTransaction(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	itemID, err := parsePathID(r, "id")
	if err != nil {
		return err
	}
	txID, err := parsePathID(r, "tx_id")
	if err != nil {
		return err
	}
	if err := h.svc.DeleteTransaction(r.Context(), uid, itemID, txID); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

// --- Param Parsers ---

func parsePathID(r *http.Request, key string) (int64, error) {
	id, err := strconv.ParseInt(chi.URLParam(r, key), 10, 64)
	if err != nil || id <= 0 {
		return 0, httpx.BadRequest("无效的 ID")
	}
	return id, nil
}

func parseOptionalFloat(raw, name string) (*float64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return nil, httpx.BadRequest("无效的数值参数: " + name)
	}
	return &v, nil
}

func parseOptionalInt(raw, name string) (*int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return nil, httpx.BadRequest("无效的整数参数: " + name)
	}
	return &v, nil
}
