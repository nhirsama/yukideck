package messenger

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"yukideck/internal/core/crypto"
	"yukideck/internal/core/httpx"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

func Migrations() fs.FS {
	return migrationsFS
}

// Notifier is the narrow interface injected into business modules for sending notifications.
type Notifier interface {
	Send(ctx context.Context, userID int64, targetChannelIDs []int64, msg Message) ([]DeliveryResult, error)
}

type Service struct {
	store         Store
	registry      *Registry
	bus           *CommandBus
	box           *crypto.Box
	publicBaseURL string
	sendTimeout   time.Duration
	logger        *slog.Logger
}

func NewService(
	store Store,
	registry *Registry,
	bus *CommandBus,
	box *crypto.Box,
	publicBaseURL string,
	sendTimeout time.Duration,
	logger *slog.Logger,
) *Service {
	if sendTimeout <= 0 {
		sendTimeout = 10 * time.Second
	}
	return &Service{
		store:         store,
		registry:      registry,
		bus:           bus,
		box:           box,
		publicBaseURL: strings.TrimRight(strings.TrimSpace(publicBaseURL), "/"),
		sendTimeout:   sendTimeout,
		logger:        logger,
	}
}

func (s *Service) CommandBus() *CommandBus { return s.bus }
func (s *Service) Drivers() []DriverInfo   { return s.registry.ListInfo() }

// ListChannels lists a user's channels, optionally filtering symmetrically by capability ("outbound" | "inbound").
func (s *Service) ListChannels(ctx context.Context, userID int64, capFilter Capability) ([]ChannelView, error) {
	records, err := s.store.ListChannels(ctx, userID)
	if err != nil {
		return nil, httpx.Internal("查询消息渠道失败", err)
	}
	views := make([]ChannelView, 0, len(records))
	for _, rec := range records {
		driver, ok := s.registry.Get(rec.Type)
		if !ok {
			continue
		}
		info := driver.Info()
		if capFilter == CapOutbound && !(info.Supports(CapOutbound) && rec.EnableOutbound) {
			continue
		}
		if capFilter == CapInbound && !(info.Supports(CapInbound) && rec.EnableInbound) {
			continue
		}
		view, err := s.toChannelView(rec, driver, "")
		if err != nil {
			return nil, err
		}
		views = append(views, view)
	}
	return views, nil
}

func (s *Service) CreateChannel(ctx context.Context, userID int64, in UpsertChannelInput) (*ChannelView, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, httpx.BadRequest("渠道名称不能为空")
	}
	driver, ok := s.registry.Get(strings.TrimSpace(in.Type))
	if !ok {
		return nil, httpx.BadRequest("不支持的渠道类型: " + in.Type)
	}
	info := driver.Info()
	if in.EnableOutbound && !info.Supports(CapOutbound) {
		return nil, httpx.BadRequest("该渠道不支持发送能力 (outbound)")
	}
	if in.EnableInbound && !info.Supports(CapInbound) {
		return nil, httpx.BadRequest("该渠道不支持接收能力 (inbound)")
	}
	if !in.EnableOutbound && !in.EnableInbound {
		return nil, httpx.BadRequest("至少需要开启发送或接收能力中的一项")
	}

	merged, err := driver.ValidateAndMergeConfig(nil, in.Config)
	if err != nil {
		return nil, httpx.BadRequest(err.Error())
	}
	encCfg, err := s.encryptMap(merged)
	if err != nil {
		return nil, httpx.Internal("加密渠道配置失败", err)
	}

	webhookSecret := ""
	if info.Supports(CapInbound) {
		webhookSecret, err = crypto.RandomToken(24)
		if err != nil {
			return nil, httpx.Internal("生成 Webhook 密钥失败", err)
		}
	}

	isDefault := in.IsDefaultOutbound && in.EnableOutbound
	created, err := s.store.CreateChannel(ctx, ChannelRecord{
		UserID:            userID,
		Type:              info.Type,
		Name:              name,
		EnableOutbound:    in.EnableOutbound,
		EnableInbound:     in.EnableInbound,
		IsDefaultOutbound: isDefault,
		Enabled:           in.Enabled,
		WebhookSecret:     webhookSecret,
		ConfigEnc:         encCfg,
	})
	if err != nil {
		return nil, httpx.Internal("创建渠道失败", err)
	}

	warning := s.syncInboundHook(ctx, driver, *created, merged)
	view, err := s.toChannelView(*created, driver, warning)
	if err != nil {
		return nil, err
	}
	return &view, nil
}

func (s *Service) UpdateChannel(ctx context.Context, userID, id int64, in UpsertChannelInput) (*ChannelView, error) {
	existing, err := s.store.GetChannel(ctx, userID, id)
	if err != nil {
		return nil, httpx.Internal("查询渠道失败", err)
	}
	if existing == nil {
		return nil, httpx.NotFound("渠道不存在")
	}
	driver, ok := s.registry.Get(existing.Type)
	if !ok {
		return nil, httpx.Internal("渠道驱动未注册: "+existing.Type, nil)
	}
	info := driver.Info()
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, httpx.BadRequest("渠道名称不能为空")
	}
	if in.EnableOutbound && !info.Supports(CapOutbound) {
		return nil, httpx.BadRequest("该渠道不支持发送能力 (outbound)")
	}
	if in.EnableInbound && !info.Supports(CapInbound) {
		return nil, httpx.BadRequest("该渠道不支持接收能力 (inbound)")
	}
	if !in.EnableOutbound && !in.EnableInbound {
		return nil, httpx.BadRequest("至少需要开启发送或接收能力中的一项")
	}

	oldCfg, err := s.decryptMap(existing.ConfigEnc)
	if err != nil {
		return nil, httpx.Internal("解密渠道配置失败", err)
	}
	merged, err := driver.ValidateAndMergeConfig(oldCfg, in.Config)
	if err != nil {
		return nil, httpx.BadRequest(err.Error())
	}
	encCfg, err := s.encryptMap(merged)
	if err != nil {
		return nil, httpx.Internal("加密渠道配置失败", err)
	}

	webhookSecret := existing.WebhookSecret
	if info.Supports(CapInbound) && webhookSecret == "" {
		webhookSecret, err = crypto.RandomToken(24)
		if err != nil {
			return nil, httpx.Internal("生成 Webhook 密钥失败", err)
		}
	}

	updated, err := s.store.UpdateChannel(ctx, ChannelRecord{
		ID:                existing.ID,
		UserID:            userID,
		Type:              existing.Type,
		Name:              name,
		EnableOutbound:    in.EnableOutbound,
		EnableInbound:     in.EnableInbound,
		IsDefaultOutbound: in.IsDefaultOutbound && in.EnableOutbound,
		Enabled:           in.Enabled,
		WebhookSecret:     webhookSecret,
		ConfigEnc:         encCfg,
	})
	if err != nil {
		return nil, httpx.Internal("更新渠道失败", err)
	}
	if updated == nil {
		return nil, httpx.NotFound("渠道不存在")
	}

	warning := s.syncInboundHook(ctx, driver, *updated, merged)
	view, err := s.toChannelView(*updated, driver, warning)
	if err != nil {
		return nil, err
	}
	return &view, nil
}

func (s *Service) DeleteChannel(ctx context.Context, userID, id int64) error {
	existing, err := s.store.GetChannel(ctx, userID, id)
	if err != nil {
		return httpx.Internal("查询渠道失败", err)
	}
	if existing == nil {
		return httpx.NotFound("渠道不存在")
	}
	if driver, ok := s.registry.Get(existing.Type); ok && existing.EnableInbound {
		if cfg, decErr := s.decryptMap(existing.ConfigEnc); decErr == nil {
			tCtx, cancel := context.WithTimeout(ctx, s.sendTimeout)
			_ = driver.TeardownInbound(tCtx, cfg)
			cancel()
		}
	}
	if err := s.store.DeleteChannel(ctx, userID, id); err != nil {
		return httpx.Internal("删除渠道失败", err)
	}
	return nil
}

func (s *Service) TestChannel(ctx context.Context, userID, id int64) error {
	rec, err := s.store.GetChannel(ctx, userID, id)
	if err != nil {
		return httpx.Internal("查询渠道失败", err)
	}
	if rec == nil {
		return httpx.NotFound("渠道不存在")
	}
	driver, ok := s.registry.Get(rec.Type)
	if !ok || !driver.Info().Supports(CapOutbound) || !rec.EnableOutbound {
		return httpx.BadRequest("该渠道未开启发送能力 (outbound)")
	}
	cfg, err := s.decryptMap(rec.ConfigEnc)
	if err != nil {
		return httpx.Internal("解密渠道配置失败", err)
	}
	sendCtx, cancel := context.WithTimeout(ctx, s.sendTimeout)
	defer cancel()
	if err := driver.Send(sendCtx, cfg, Message{
		Title:   "YukiDeck 测试推送",
		Content: fmt.Sprintf("渠道「%s」连通性验证成功。", rec.Name),
	}); err != nil {
		return httpx.BadRequest("测试推送失败: " + err.Error())
	}
	return nil
}

// Send routes an outbound message to selected outbound-capable channels, or default outbound channel(s) if targetChannelIDs is empty.
func (s *Service) Send(ctx context.Context, userID int64, targetChannelIDs []int64, msg Message) ([]DeliveryResult, error) {
	all, err := s.store.ListChannels(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list channels: %w", err)
	}

	targetSet := make(map[int64]struct{}, len(targetChannelIDs))
	for _, id := range targetChannelIDs {
		targetSet[id] = struct{}{}
	}

	var targets []ChannelRecord
	for _, ch := range all {
		if !ch.Enabled || !ch.EnableOutbound {
			continue
		}
		driver, ok := s.registry.Get(ch.Type)
		if !ok || !driver.Info().Supports(CapOutbound) {
			continue
		}
		if len(targetSet) > 0 {
			if _, match := targetSet[ch.ID]; match {
				targets = append(targets, ch)
			}
		} else if ch.IsDefaultOutbound {
			targets = append(targets, ch)
		}
	}

	if len(targets) == 0 {
		return nil, httpx.BadRequest("未找到可用的出站推送渠道（请检查默认渠道或所选渠道的发送能力）")
	}

	results := make([]DeliveryResult, len(targets))
	var wg sync.WaitGroup
	for i, ch := range targets {
		wg.Add(1)
		go func(idx int, rec ChannelRecord) {
			defer wg.Done()
			res := DeliveryResult{
				ChannelID:   rec.ID,
				ChannelName: rec.Name,
				ChannelType: rec.Type,
			}
			driver, _ := s.registry.Get(rec.Type)
			cfg, err := s.decryptMap(rec.ConfigEnc)
			if err != nil {
				res.Error = "配置解密失败"
				results[idx] = res
				return
			}
			sendCtx, cancel := context.WithTimeout(ctx, s.sendTimeout)
			defer cancel()
			if err := driver.Send(sendCtx, cfg, msg); err != nil {
				res.Error = err.Error()
			} else {
				res.OK = true
			}
			results[idx] = res
		}(i, ch)
	}
	wg.Wait()
	return results, nil
}

// --- Normalized PushURL ---

func (s *Service) ListPushEndpoints(ctx context.Context, userID int64) ([]PushEndpointView, error) {
	recs, err := s.store.ListPushEndpoints(ctx, userID)
	if err != nil {
		return nil, httpx.Internal("查询 PushURL 列表失败", err)
	}
	out := make([]PushEndpointView, 0, len(recs))
	for _, r := range recs {
		v, err := s.toPushEndpointView(r)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

func (s *Service) CreatePushEndpoint(ctx context.Context, userID int64, in UpsertPushEndpointInput) (*PushEndpointView, error) {
	if err := s.validatePushEndpointInput(ctx, userID, in); err != nil {
		return nil, err
	}
	rawToken, err := crypto.RandomToken(24)
	if err != nil {
		return nil, httpx.Internal("生成 PushURL token 失败", err)
	}
	tokenEnc, err := s.box.Encrypt([]byte(rawToken))
	if err != nil {
		return nil, httpx.Internal("加密 PushURL token 失败", err)
	}
	created, err := s.store.CreatePushEndpoint(ctx, PushEndpointRecord{
		UserID:           userID,
		Name:             strings.TrimSpace(in.Name),
		TokenHash:        crypto.SHA256Hex(rawToken),
		TokenEnc:         tokenEnc,
		TargetMode:       in.TargetMode,
		TargetChannelIDs: in.TargetChannelIDs,
		Enabled:          in.Enabled,
	})
	if err != nil {
		return nil, httpx.Internal("创建 PushURL 失败", err)
	}
	v, err := s.toPushEndpointView(*created)
	if err != nil {
		return nil, err
	}
	return &v, nil
}

func (s *Service) UpdatePushEndpoint(ctx context.Context, userID, id int64, in UpsertPushEndpointInput) (*PushEndpointView, error) {
	if err := s.validatePushEndpointInput(ctx, userID, in); err != nil {
		return nil, err
	}
	updated, err := s.store.UpdatePushEndpoint(ctx, PushEndpointRecord{
		ID:               id,
		UserID:           userID,
		Name:             strings.TrimSpace(in.Name),
		TargetMode:       in.TargetMode,
		TargetChannelIDs: in.TargetChannelIDs,
		Enabled:          in.Enabled,
	})
	if err != nil {
		return nil, httpx.Internal("更新 PushURL 失败", err)
	}
	if updated == nil {
		return nil, httpx.NotFound("PushURL 不存在")
	}
	v, err := s.toPushEndpointView(*updated)
	if err != nil {
		return nil, err
	}
	return &v, nil
}

func (s *Service) RotatePushEndpointToken(ctx context.Context, userID, id int64) (*PushEndpointView, error) {
	rawToken, err := crypto.RandomToken(24)
	if err != nil {
		return nil, httpx.Internal("生成新 token 失败", err)
	}
	tokenEnc, err := s.box.Encrypt([]byte(rawToken))
	if err != nil {
		return nil, httpx.Internal("加密新 token 失败", err)
	}
	updated, err := s.store.RotatePushEndpointToken(ctx, userID, id, crypto.SHA256Hex(rawToken), tokenEnc)
	if err != nil {
		return nil, httpx.Internal("重置 PushURL token 失败", err)
	}
	if updated == nil {
		return nil, httpx.NotFound("PushURL 不存在")
	}
	v, err := s.toPushEndpointView(*updated)
	if err != nil {
		return nil, err
	}
	return &v, nil
}

func (s *Service) DeletePushEndpoint(ctx context.Context, userID, id int64) error {
	if err := s.store.DeletePushEndpoint(ctx, userID, id); err != nil {
		return httpx.Internal("删除 PushURL 失败", err)
	}
	return nil
}

func (s *Service) DispatchPushEndpoint(ctx context.Context, rawToken string, msg Message) ([]DeliveryResult, error) {
	if strings.TrimSpace(rawToken) == "" {
		return nil, httpx.NotFound("无效的 PushURL")
	}
	if strings.TrimSpace(msg.Title) == "" && strings.TrimSpace(msg.Content) == "" {
		return nil, httpx.BadRequest("推送内容不能为空（请提供 title 或 content）")
	}

	ep, err := s.store.GetPushEndpointByTokenHash(ctx, crypto.SHA256Hex(rawToken))
	if err != nil {
		return nil, httpx.Internal("查询 PushURL 失败", err)
	}
	if ep == nil || !ep.Enabled {
		return nil, httpx.NotFound("PushURL 不存在或已停用")
	}

	var targetIDs []int64
	if ep.TargetMode == "selected" {
		targetIDs = ep.TargetChannelIDs
	}
	results, err := s.Send(ctx, ep.UserID, targetIDs, msg)
	if err != nil {
		return nil, err
	}
	_ = s.store.TouchPushEndpointCalled(ctx, ep.ID)
	return results, nil
}

// --- Inbound Webhook ---

func (s *Service) HandleWebhook(ctx context.Context, driverType string, channelID int64, r *http.Request) error {
	rec, err := s.store.GetChannelByID(ctx, channelID)
	if err != nil {
		return httpx.Internal("查询渠道失败", err)
	}
	if rec == nil || rec.Type != driverType || !rec.Enabled || !rec.EnableInbound {
		return httpx.NotFound("入站渠道未启用或不存在")
	}
	driver, ok := s.registry.Get(rec.Type)
	if !ok || !driver.Info().Supports(CapInbound) {
		return httpx.NotFound("渠道不支持入站能力")
	}
	cfg, err := s.decryptMap(rec.ConfigEnc)
	if err != nil {
		return httpx.Internal("解密渠道配置失败", err)
	}

	ev, err := driver.ParseInbound(ctx, r, cfg, rec.WebhookSecret)
	if err != nil {
		if err == ErrUnauthorizedWebhook {
			return httpx.Unauthorized("Webhook 鉴权失败")
		}
		return httpx.BadRequest("解析入站事件失败: " + err.Error())
	}
	if ev == nil {
		// Ignored non-actionable platform event (e.g. edited message or typing indicator)
		return nil
	}
	ev.UserID = rec.UserID
	ev.ChannelID = rec.ID
	ev.ChannelType = rec.Type

	reply, err := s.bus.Dispatch(ctx, ev)
	if err != nil {
		reply = &Message{Content: "执行失败: " + err.Error()}
	}
	if reply == nil {
		return nil
	}

	// Reply via same channel if it supports & enables outbound, otherwise fallback to default outbound channel.
	var targetIDs []int64
	if driver.Info().Supports(CapOutbound) && rec.EnableOutbound {
		targetIDs = []int64{rec.ID}
	}
	if _, sendErr := s.Send(ctx, rec.UserID, targetIDs, *reply); sendErr != nil && s.logger != nil {
		s.logger.Warn("failed to send inbound reply", "channel_id", rec.ID, "err", sendErr)
	}
	return nil
}

// --- Helpers ---

func (s *Service) validatePushEndpointInput(ctx context.Context, userID int64, in UpsertPushEndpointInput) error {
	if strings.TrimSpace(in.Name) == "" {
		return httpx.BadRequest("PushURL 名称不能为空")
	}
	if in.TargetMode != "default" && in.TargetMode != "selected" {
		return httpx.BadRequest("target_mode 必须为 default 或 selected")
	}
	if in.TargetMode == "selected" {
		if len(in.TargetChannelIDs) == 0 {
			return httpx.BadRequest("选择指定渠道模式时，至少需要勾选一个具备发送能力的渠道")
		}
		outboundChannels, err := s.ListChannels(ctx, userID, CapOutbound)
		if err != nil {
			return err
		}
		validSet := make(map[int64]struct{}, len(outboundChannels))
		for _, ch := range outboundChannels {
			validSet[ch.ID] = struct{}{}
		}
		for _, id := range in.TargetChannelIDs {
			if _, ok := validSet[id]; !ok {
				return httpx.BadRequest(fmt.Sprintf("渠道 #%d 不存在或未启用发送能力 (outbound)", id))
			}
		}
	}
	return nil
}

func (s *Service) syncInboundHook(ctx context.Context, driver Driver, rec ChannelRecord, cfg map[string]any) string {
	if !driver.Info().Supports(CapInbound) {
		return ""
	}
	tCtx, cancel := context.WithTimeout(ctx, s.sendTimeout)
	defer cancel()

	if rec.Enabled && rec.EnableInbound {
		if !strings.HasPrefix(s.publicBaseURL, "https://") {
			return "已开启接收能力，但 PUBLIC_BASE_URL 非 HTTPS，未自动注册远程 Webhook（部署 HTTPS 后重新保存即可自动注册）"
		}
		webhookURL := s.webhookURL(rec.Type, rec.ID)
		if err := driver.SetupInbound(tCtx, cfg, webhookURL, rec.WebhookSecret); err != nil {
			return "远程 Webhook 注册失败: " + err.Error()
		}
		return ""
	}

	_ = driver.TeardownInbound(tCtx, cfg)
	return ""
}

func (s *Service) webhookURL(driverType string, id int64) string {
	return fmt.Sprintf("%s/api/v1/messenger/webhook/%s/%d", s.publicBaseURL, driverType, id)
}

func (s *Service) toChannelView(rec ChannelRecord, driver Driver, warning string) (ChannelView, error) {
	plain, err := s.decryptMap(rec.ConfigEnc)
	if err != nil {
		return ChannelView{}, httpx.Internal("解密渠道配置失败", err)
	}
	info := driver.Info()
	webhookURL := ""
	if info.Supports(CapInbound) {
		webhookURL = s.webhookURL(rec.Type, rec.ID)
	}
	return ChannelView{
		ID:                rec.ID,
		Type:              rec.Type,
		Name:              rec.Name,
		Capabilities:      info.Capabilities,
		EnableOutbound:    rec.EnableOutbound,
		EnableInbound:     rec.EnableInbound,
		IsDefaultOutbound: rec.IsDefaultOutbound,
		Enabled:           rec.Enabled,
		Config:            driver.MaskConfig(plain),
		WebhookURL:        webhookURL,
		WebhookWarning:    warning,
		CreatedAt:         rec.CreatedAt,
		UpdatedAt:         rec.UpdatedAt,
	}, nil
}

func (s *Service) toPushEndpointView(rec PushEndpointRecord) (PushEndpointView, error) {
	rawToken, err := s.box.Decrypt(rec.TokenEnc)
	if err != nil {
		return PushEndpointView{}, httpx.Internal("解密 PushURL token 失败", err)
	}
	return PushEndpointView{
		ID:               rec.ID,
		Name:             rec.Name,
		PushURL:          fmt.Sprintf("%s/api/v1/push/%s", s.publicBaseURL, string(rawToken)),
		TargetMode:       rec.TargetMode,
		TargetChannelIDs: rec.TargetChannelIDs,
		Enabled:          rec.Enabled,
		LastCalledAt:     rec.LastCalledAt,
		CreatedAt:        rec.CreatedAt,
		UpdatedAt:        rec.UpdatedAt,
	}, nil
}

func (s *Service) encryptMap(m map[string]any) (string, error) {
	raw, err := json.Marshal(m)
	if err != nil {
		return "", err
	}
	return s.box.Encrypt(raw)
}

func (s *Service) decryptMap(enc string) (map[string]any, error) {
	raw, err := s.box.Decrypt(enc)
	if err != nil {
		return nil, err
	}
	out := make(map[string]any)
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}
