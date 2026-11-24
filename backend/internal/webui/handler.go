package webui

import (
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// NewHandler serves the embedded React SPA when enabled, while strictly excluding /api/* paths.
func NewHandler(fsys fs.FS, enabled bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !enabled || fsys == nil {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}

		cleanPath := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if cleanPath == "" {
			cleanPath = "index.html"
		}

		if serveFileIfExists(w, r, fsys, cleanPath) {
			return
		}
		serveFileIfExists(w, r, fsys, "index.html")
	})
}

func serveFileIfExists(w http.ResponseWriter, r *http.Request, fsys fs.FS, name string) bool {
	f, err := fsys.Open(name)
	if err != nil {
		return false
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil || stat.IsDir() {
		return false
	}

	if strings.HasPrefix(name, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else if name == "index.html" {
		w.Header().Set("Cache-Control", "no-cache")
	}

	if rs, ok := f.(io.ReadSeeker); ok {
		http.ServeContent(w, r, stat.Name(), stat.ModTime(), rs)
		return true
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return false
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
	return true
}
