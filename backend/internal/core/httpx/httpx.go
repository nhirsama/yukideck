package httpx

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// AppError represents a structured HTTP error returned by handlers.
type AppError struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Err     error  `json:"-"`
}

func (e *AppError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %v", e.Message, e.Err)
	}
	return e.Message
}

func (e *AppError) Unwrap() error { return e.Err }

func BadRequest(msg string) *AppError {
	return &AppError{Status: http.StatusBadRequest, Code: "bad_request", Message: msg}
}

func Unauthorized(msg string) *AppError {
	return &AppError{Status: http.StatusUnauthorized, Code: "unauthorized", Message: msg}
}

func Forbidden(msg string) *AppError {
	return &AppError{Status: http.StatusForbidden, Code: "forbidden", Message: msg}
}

func NotFound(msg string) *AppError {
	return &AppError{Status: http.StatusNotFound, Code: "not_found", Message: msg}
}

func Conflict(msg string) *AppError {
	return &AppError{Status: http.StatusConflict, Code: "conflict", Message: msg}
}

func PayloadTooLarge(msg string) *AppError {
	return &AppError{Status: http.StatusRequestEntityTooLarge, Code: "payload_too_large", Message: msg}
}

func Internal(msg string, err error) *AppError {
	return &AppError{Status: http.StatusInternalServerError, Code: "internal_error", Message: msg, Err: err}
}

// HandlerFunc lets HTTP handlers return structured errors cleanly.
type HandlerFunc func(w http.ResponseWriter, r *http.Request) error

// Handle wraps HandlerFunc into a standard net/http.HandlerFunc with centralized error formatting.
func Handle(logger *slog.Logger, fn HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := fn(w, r); err != nil {
			WriteError(w, r, logger, err)
		}
	}
}

func JSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if payload == nil {
		return
	}
	_ = json.NewEncoder(w).Encode(payload)
}

func WriteError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, err error) {
	var appErr *AppError
	if errors.As(err, &appErr) {
		if appErr.Status >= 500 && logger != nil {
			logger.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", appErr.Err)
		}
		JSON(w, appErr.Status, map[string]any{
			"error": map[string]string{
				"code":    appErr.Code,
				"message": appErr.Message,
			},
		})
		return
	}

	if logger != nil {
		logger.Error("unhandled error", "method", r.Method, "path", r.URL.Path, "err", err)
	}
	JSON(w, http.StatusInternalServerError, map[string]any{
		"error": map[string]string{
			"code":    "internal_error",
			"message": "服务器内部错误",
		},
	})
}

// DecodeJSON reads a bounded JSON body (server memory guardrail) into dst.
func DecodeJSON(w http.ResponseWriter, r *http.Request, maxBytes int64, dst any) error {
	if maxBytes <= 0 {
		maxBytes = 1 << 20
	}
	if r.ContentLength > maxBytes {
		return PayloadTooLarge("请求体超出服务器允许大小上限")
	}
	reader := http.MaxBytesReader(w, r.Body, maxBytes)
	dec := json.NewDecoder(reader)
	if err := dec.Decode(dst); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return PayloadTooLarge("请求体超出服务器允许大小上限")
		}
		if errors.Is(err, io.EOF) {
			return BadRequest("请求体不能为空")
		}
		return BadRequest("JSON 格式无效: " + err.Error())
	}
	return nil
}

// CORSMiddleware supports separated frontend/backend deployments with credentialed requests.
func CORSMiddleware(allowedOrigins []string) func(http.Handler) http.Handler {
	allowed := make(map[string]struct{}, len(allowedOrigins))
	for _, o := range allowedOrigins {
		clean := strings.TrimRight(strings.TrimSpace(o), "/")
		if clean != "" {
			allowed[clean] = struct{}{}
		}
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := strings.TrimRight(strings.TrimSpace(r.Header.Get("Origin")), "/")
			if origin != "" {
				if _, ok := allowed[origin]; ok {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Vary", "Origin")
					w.Header().Set("Access-Control-Allow-Credentials", "true")
					w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
					w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")
				}
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (sr *statusRecorder) WriteHeader(code int) {
	sr.status = code
	sr.ResponseWriter.WriteHeader(code)
}

func (sr *statusRecorder) Unwrap() http.ResponseWriter {
	return sr.ResponseWriter
}

func (sr *statusRecorder) Flush() {
	if flusher, ok := sr.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func RequestLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r)
			if logger != nil && r.URL.Path != "/healthz" {
				logger.Info("http",
					"method", r.Method,
					"path", r.URL.Path,
					"status", rec.status,
					"duration_ms", time.Since(start).Milliseconds(),
				)
			}
		})
	}
}

func Recoverer(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					if logger != nil {
						logger.Error("panic recovered", "path", r.URL.Path, "panic", rec)
					}
					WriteError(w, r, logger, Internal("服务器异常", fmt.Errorf("%v", rec)))
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}
