//go:build embed_ui

package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var rawDistFS embed.FS

func EmbeddedFS() fs.FS {
	sub, err := fs.Sub(rawDistFS, "dist")
	if err != nil {
		return nil
	}
	return sub
}
