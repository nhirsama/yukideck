//go:build !embed_ui

package webui

import "io/fs"

func EmbeddedFS() fs.FS {
	return nil
}
