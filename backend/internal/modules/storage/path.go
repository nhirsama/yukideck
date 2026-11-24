package storage

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
)

const FolderKeepFilename = ".keep"

var (
	validExtRe = regexp.MustCompile(`^\.[a-z0-9]{1,12}$`)

	imageExtensions = map[string]struct{}{
		".jpg":  {},
		".jpeg": {},
		".png":  {},
		".webp": {},
		".gif":  {},
		".svg":  {},
		".avif": {},
		".bmp":  {},
		".ico":  {},
	}

	mimeByExtension = map[string]string{
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".png":  "image/png",
		".webp": "image/webp",
		".gif":  "image/gif",
		".svg":  "image/svg+xml",
		".avif": "image/avif",
		".bmp":  "image/bmp",
		".ico":  "image/x-icon",
		".pdf":  "application/pdf",
		".txt":  "text/plain; charset=utf-8",
		".md":   "text/markdown; charset=utf-8",
		".json": "application/json; charset=utf-8",
		".zip":  "application/zip",
		".tar":  "application/x-tar",
		".gz":   "application/gzip",
		".7z":   "application/x-7z-compressed",
		".mp4":  "video/mp4",
		".webm": "video/webm",
		".mp3":  "audio/mpeg",
		".wav":  "audio/wav",
		".ogg":  "audio/ogg",
	}
)

func hasIllegalPathChars(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == '\\' {
			return true
		}
	}
	return false
}

func NormalizeFolderPrefix(raw string) (string, error) {
	trimmed := strings.Trim(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return "", nil
	}
	parts := strings.Split(trimmed, "/")
	clean := make([]string, 0, len(parts))
	for _, p := range parts {
		s := strings.TrimSpace(p)
		if s == "" {
			continue
		}
		if s == "." || s == ".." {
			return "", errors.New(`路径不能包含 "." 或 ".."`)
		}
		if hasIllegalPathChars(s) {
			return "", errors.New("路径包含非法字符")
		}
		clean = append(clean, s)
	}
	if len(clean) == 0 {
		return "", nil
	}
	return strings.Join(clean, "/") + "/", nil
}

func NormalizeObjectKey(raw string) (string, error) {
	trimmed := strings.Trim(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return "", errors.New("文件路径不能为空")
	}
	parts := strings.Split(trimmed, "/")
	clean := make([]string, 0, len(parts))
	for _, p := range parts {
		s := strings.TrimSpace(p)
		if s == "" {
			return "", errors.New("路径不能包含空目录段")
		}
		if s == "." || s == ".." {
			return "", errors.New(`路径不能包含 "." 或 ".."`)
		}
		if hasIllegalPathChars(s) {
			return "", errors.New("路径包含非法字符")
		}
		clean = append(clean, s)
	}
	key := strings.Join(clean, "/")
	if key == FolderKeepFilename || strings.HasSuffix(key, "/"+FolderKeepFilename) {
		return "", errors.New("该名称为系统保留路径")
	}
	return key, nil
}

func BuildPublicURL(baseURL, key string) string {
	segments := strings.Split(key, "/")
	encoded := make([]string, len(segments))
	for i, seg := range segments {
		encoded[i] = url.PathEscape(seg)
	}
	trimmedBase := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if trimmedBase == "" {
		return "/" + strings.Join(encoded, "/")
	}
	return trimmedBase + "/" + strings.Join(encoded, "/")
}

func GetLowerExtension(filename string) string {
	idx := strings.LastIndexByte(filename, '.')
	if idx <= 0 || idx == len(filename)-1 {
		return ""
	}
	ext := strings.ToLower(filename[idx:])
	if validExtRe.MatchString(ext) {
		return ext
	}
	return ""
}

func GuessExtensionFromMime(mimeType string) string {
	clean := strings.ToLower(strings.TrimSpace(strings.Split(mimeType, ";")[0]))
	if clean == "" {
		return ""
	}
	if clean == "image/jpeg" {
		return ".jpg"
	}
	for ext, m := range mimeByExtension {
		if strings.Split(m, ";")[0] == clean {
			return ext
		}
	}
	return ""
}

func ResolveContentType(provided, filename string) string {
	p := strings.TrimSpace(provided)
	if p != "" && p != "application/octet-stream" {
		return p
	}
	ext := GetLowerExtension(filename)
	if m, ok := mimeByExtension[ext]; ok {
		return m
	}
	return "application/octet-stream"
}

func IsImageFile(contentType, filename string) bool {
	if strings.HasPrefix(strings.ToLower(contentType), "image/") {
		return true
	}
	_, ok := imageExtensions[GetLowerExtension(filename)]
	return ok
}
