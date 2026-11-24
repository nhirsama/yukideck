package storage

import (
	"context"
	"embed"
	"fmt"
	"io/fs"

	"github.com/go-chi/chi/v5"

	"yukideck/internal/core/messenger"
	"yukideck/internal/core/module"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

type Module struct {
	module.BaseModule
	svc     *Service
	handler *Handler
}

func New(deps module.Deps) *Module {
	factory := func(cfg PlainConfig) (Bucket, error) {
		return NewAWSS3Bucket(cfg, deps.Config.ExternalHTTPTimeout)
	}
	svc := NewService(NewPGConfigStore(deps.DB), deps.Crypto, factory, deps.Config.StorageProxyMaxMB)
	handler := NewHandler(svc, deps.Config.RequestMaxBodyBytes, deps.Logger)
	return &Module{svc: svc, handler: handler}
}

func (m *Module) Meta() module.Meta {
	return module.Meta{
		ID:          "storage",
		Name:        "图床管理",
		Description: "基于用户自有 S3 / R2 对象存储桶的轻量相册与文件管理（支持直传与无损去 EXIF）",
		APIPrefix:   "/api/v1/storage",
	}
}

func (m *Module) Migrations() fs.FS {
	return migrationsFS
}

func (m *Module) RegisterRoutes(r chi.Router) {
	m.handler.RegisterRoutes(r)
}

// RegisterCommands hooks minimal image upload support into the platform CommandBus (e.g. sending a photo to Telegram Bot).
func (m *Module) RegisterCommands(bus *messenger.CommandBus) {
	bus.RegisterMediaHandler(messenger.MediaHandlerSpec{
		MediaType:   "image",
		ModuleID:    "storage",
		Description: "直接发送图片自动无损去 EXIF 并上传到你的对象存储图床",
		Handler: func(ctx context.Context, ev *messenger.IncomingEvent) (*messenger.Message, error) {
			if len(ev.Attachments) == 0 || ev.Attachments[0].Download == nil {
				return nil, nil
			}
			att := ev.Attachments[0]
			data, err := att.Download(ctx, m.svc.ProxyMaxBytes())
			if err != nil {
				return nil, err
			}
			saved, err := m.svc.ProxyUpload(ctx, ev.UserID, data, att.FileName, att.MimeType, "telegram", "", false)
			if err != nil {
				return nil, err
			}
			return &messenger.Message{
				Title:   "图床上传成功",
				Content: fmt.Sprintf("直链：\n%s\n\nMarkdown：\n![](%s)", saved.URL, saved.URL),
			}, nil
		},
	})
}
