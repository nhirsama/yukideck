package storage

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"yukideck/internal/core/auth"
	"yukideck/internal/core/httpx"
)

type Handler struct {
	svc             *Service
	jsonMaxBodyByte int64
	logger          *slog.Logger
}

func NewHandler(svc *Service, jsonMaxBodyBytes int64, logger *slog.Logger) *Handler {
	if jsonMaxBodyBytes <= 0 {
		jsonMaxBodyBytes = 1 << 20
	}
	return &Handler{svc: svc, jsonMaxBodyByte: jsonMaxBodyBytes, logger: logger}
}

func (h *Handler) RegisterRoutes(r chi.Router) {
	r.Get("/config", httpx.Handle(h.logger, h.getConfig))
	r.Put("/config", httpx.Handle(h.logger, h.saveConfig))
	r.Post("/config/test", httpx.Handle(h.logger, h.testConfig))

	r.Get("/list", httpx.Handle(h.logger, h.listDirectory))
	r.Get("/folders", httpx.Handle(h.logger, h.listSubfolders))
	r.Post("/folder", httpx.Handle(h.logger, h.createFolder))

	r.Post("/presign", httpx.Handle(h.logger, h.presignDirect))
	r.Post("/upload", httpx.Handle(h.logger, h.proxyUpload))

	r.Post("/rename", httpx.Handle(h.logger, h.renameEntry))
	r.Post("/move", httpx.Handle(h.logger, h.moveEntries))
	r.Post("/delete", httpx.Handle(h.logger, h.deleteEntries))
}

func (h *Handler) getConfig(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	cfg, err := h.svc.GetConfig(r.Context(), uid)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"config": cfg})
	return nil
}

func (h *Handler) saveConfig(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in SaveConfigInput
	if err := httpx.DecodeJSON(w, r, h.jsonMaxBodyByte, &in); err != nil {
		return err
	}
	cfg, err := h.svc.SaveConfig(r.Context(), uid, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"config": cfg})
	return nil
}

func (h *Handler) testConfig(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	if err := h.svc.TestConnection(r.Context(), uid); err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

func (h *Handler) listDirectory(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	prefix := r.URL.Query().Get("prefix")
	cursor := r.URL.Query().Get("cursor")
	res, err := h.svc.ListDirectory(r.Context(), uid, prefix, cursor)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
	return nil
}

func (h *Handler) listSubfolders(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	prefix, folders, err := h.svc.ListSubfolders(r.Context(), uid, r.URL.Query().Get("prefix"))
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"prefix": prefix, "folders": folders})
	return nil
}

func (h *Handler) createFolder(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in struct {
		Path string `json:"path"`
	}
	if err := httpx.DecodeJSON(w, r, h.jsonMaxBodyByte, &in); err != nil {
		return err
	}
	folder, err := h.svc.CreateFolder(r.Context(), uid, in.Path)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"ok": true, "folder": folder})
	return nil
}

func (h *Handler) presignDirect(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in PresignInput
	if err := httpx.DecodeJSON(w, r, h.jsonMaxBodyByte, &in); err != nil {
		return err
	}
	res, err := h.svc.PresignDirectUpload(r.Context(), uid, in)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, res)
	return nil
}

func (h *Handler) proxyUpload(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}

	// Enforce server-configured memory/bandwidth guardrail for proxy uploads.
	maxBytes := h.svc.ProxyMaxBytes()
	// Allow tiny multipart boundary overhead (+512KB) on the outer HTTP body, while still checking exact file bytes below.
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes+(512<<10))

	if err := r.ParseMultipartForm(8 << 20); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return httpx.PayloadTooLarge(fmt.Sprintf("中转上传超出服务器安全上限 (%d MB)", h.svc.proxyMaxMB))
		}
		return httpx.BadRequest("解析上传表单失败: " + err.Error())
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		return httpx.BadRequest("未找到上传的文件字段 (file)")
	}
	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return httpx.PayloadTooLarge(fmt.Sprintf("中转上传超出服务器安全上限 (%d MB)", h.svc.proxyMaxMB))
		}
		return httpx.BadRequest("读取上传文件失败")
	}
	if int64(len(data)) > maxBytes {
		return httpx.PayloadTooLarge(fmt.Sprintf("中转上传超出服务器安全上限 (%d MB)", h.svc.proxyMaxMB))
	}

	folder := r.FormValue("folder")
	customName := r.FormValue("customName")
	alreadyStripped := strings.EqualFold(r.Header.Get("X-Metadata-Stripped"), "true") ||
		strings.EqualFold(r.FormValue("stripped"), "true")

	entry, err := h.svc.ProxyUpload(
		r.Context(),
		uid,
		data,
		header.Filename,
		header.Header.Get("Content-Type"),
		folder,
		customName,
		alreadyStripped,
	)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"ok": true, "file": entry})
	return nil
}

func (h *Handler) renameEntry(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in struct {
		Type    string `json:"type"`
		OldPath string `json:"oldPath"`
		NewPath string `json:"newPath"`
	}
	if err := httpx.DecodeJSON(w, r, h.jsonMaxBodyByte, &in); err != nil {
		return err
	}
	oldP, newP, moved, pubURL, err := h.svc.RenameEntry(r.Context(), uid, in.Type, in.OldPath, in.NewPath)
	if err != nil {
		return err
	}
	resp := map[string]any{
		"ok":         true,
		"oldPath":    oldP,
		"newPath":    newP,
		"movedCount": moved,
	}
	if pubURL != "" {
		resp["url"] = pubURL
	}
	httpx.JSON(w, http.StatusOK, resp)
	return nil
}

func (h *Handler) moveEntries(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in struct {
		Items        []PathItem `json:"items"`
		TargetFolder string     `json:"targetFolder"`
	}
	if err := httpx.DecodeJSON(w, r, h.jsonMaxBodyByte, &in); err != nil {
		return err
	}
	moved, err := h.svc.MoveEntries(r.Context(), uid, in.Items, in.TargetFolder)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "movedCount": moved})
	return nil
}

func (h *Handler) deleteEntries(w http.ResponseWriter, r *http.Request) error {
	uid, ok := auth.UserID(r.Context())
	if !ok {
		return httpx.Unauthorized("未登录")
	}
	var in struct {
		Type  string     `json:"type"`
		Path  string     `json:"path"`
		Items []PathItem `json:"items"`
	}
	if err := httpx.DecodeJSON(w, r, h.jsonMaxBodyByte, &in); err != nil {
		return err
	}
	items := in.Items
	if len(items) == 0 && in.Type != "" && in.Path != "" {
		items = []PathItem{{Type: in.Type, Path: in.Path}}
	}
	deleted, err := h.svc.DeleteEntries(r.Context(), uid, items)
	if err != nil {
		return err
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "deletedCount": deleted})
	return nil
}
