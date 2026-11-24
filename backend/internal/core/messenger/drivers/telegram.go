package drivers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"yukideck/internal/core/crypto"
	"yukideck/internal/core/messenger"
)

const telegramSecretHeader = "X-Telegram-Bot-Api-Secret-Token"

// TelegramDriver implements both outbound and inbound capabilities for a user's own Telegram Bot.
type TelegramDriver struct {
	APIBaseURL string
	HTTPClient *http.Client
}

func NewTelegramDriver(timeout time.Duration) *TelegramDriver {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &TelegramDriver{
		APIBaseURL: "https://api.telegram.org",
		HTTPClient: &http.Client{Timeout: timeout},
	}
}

func (d *TelegramDriver) Info() messenger.DriverInfo {
	return messenger.DriverInfo{
		Type:         "telegram",
		DisplayName:  "Telegram Bot",
		Description:  "支持单向通知推送与双向机器人指令/图片交互（填写你自己的 Bot Token 与 Chat ID）",
		Capabilities: []messenger.Capability{messenger.CapOutbound, messenger.CapInbound},
		Fields: []messenger.ConfigField{
			{Key: "bot_token", Label: "Bot Token", Placeholder: "123456789:AAH...", Secret: true, Required: true},
			{Key: "chat_id", Label: "Chat ID", Placeholder: "你的个人 Telegram Chat ID（纯数字）", Secret: false, Required: true},
		},
	}
}

func (d *TelegramDriver) ValidateAndMergeConfig(existingPlain, incoming map[string]any) (map[string]any, error) {
	botToken := getString(incoming, "bot_token")
	if botToken == "" && existingPlain != nil {
		botToken = getString(existingPlain, "bot_token")
	}
	chatID := getString(incoming, "chat_id")
	if chatID == "" && existingPlain != nil {
		chatID = getString(existingPlain, "chat_id")
	}
	if botToken == "" {
		return nil, errors.New("请填写 Telegram Bot Token")
	}
	if !strings.Contains(botToken, ":") {
		return nil, errors.New("Telegram Bot Token 格式无效")
	}
	if chatID == "" {
		return nil, errors.New("请填写 Telegram Chat ID")
	}
	if _, err := strconv.ParseInt(chatID, 10, 64); err != nil {
		return nil, errors.New("Telegram Chat ID 必须为整数")
	}
	return map[string]any{
		"bot_token": botToken,
		"chat_id":   chatID,
	}, nil
}

func (d *TelegramDriver) MaskConfig(plain map[string]any) map[string]any {
	token := getString(plain, "bot_token")
	masked := ""
	if len(token) > 8 {
		masked = token[:4] + "****" + token[len(token)-4:]
	} else if token != "" {
		masked = "****"
	}
	return map[string]any{
		"bot_token_masked": masked,
		"has_bot_token":    token != "",
		"chat_id":          getString(plain, "chat_id"),
	}
}

func (d *TelegramDriver) Send(ctx context.Context, cfg map[string]any, msg messenger.Message) error {
	botToken := getString(cfg, "bot_token")
	chatID := getString(cfg, "chat_id")
	if botToken == "" || chatID == "" {
		return errors.New("telegram 配置不完整")
	}

	text := strings.TrimSpace(msg.Content)
	if title := strings.TrimSpace(msg.Title); title != "" {
		if text != "" {
			text = title + "\n\n" + text
		} else {
			text = title
		}
	}
	if text == "" {
		return errors.New("消息内容不能为空")
	}

	payload := map[string]any{
		"chat_id": chatID,
		"text":    text,
	}
	return d.callAPI(ctx, botToken, "sendMessage", payload, nil)
}

func (d *TelegramDriver) SetupInbound(ctx context.Context, cfg map[string]any, webhookURL, secret string) error {
	botToken := getString(cfg, "bot_token")
	if botToken == "" {
		return errors.New("缺少 bot_token")
	}
	payload := map[string]any{
		"url":             webhookURL,
		"secret_token":    secret,
		"allowed_updates": []string{"message"},
	}
	return d.callAPI(ctx, botToken, "setWebhook", payload, nil)
}

func (d *TelegramDriver) TeardownInbound(ctx context.Context, cfg map[string]any) error {
	botToken := getString(cfg, "bot_token")
	if botToken == "" {
		return nil
	}
	return d.callAPI(ctx, botToken, "deleteWebhook", map[string]any{}, nil)
}

func (d *TelegramDriver) ParseInbound(ctx context.Context, r *http.Request, cfg map[string]any, secret string) (*messenger.IncomingEvent, error) {
	if secret != "" {
		gotSecret := r.Header.Get(telegramSecretHeader)
		if !crypto.ConstantTimeEqual(gotSecret, secret) {
			return nil, messenger.ErrUnauthorizedWebhook
		}
	}

	var update struct {
		Message *struct {
			Chat struct {
				ID int64 `json:"id"`
			} `json:"chat"`
			Text    string `json:"text"`
			Caption string `json:"caption"`
			Photo   []struct {
				FileID   string `json:"file_id"`
				FileSize int64  `json:"file_size"`
			} `json:"photo"`
			Document *struct {
				FileID   string `json:"file_id"`
				FileName string `json:"file_name"`
				MimeType string `json:"mime_type"`
				FileSize int64  `json:"file_size"`
			} `json:"document"`
		} `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
		return nil, fmt.Errorf("decode telegram update: %w", err)
	}
	if update.Message == nil {
		return nil, nil
	}

	// Strictly bind inbound interaction to the configured chat_id so strangers cannot operate the user's hub.
	expectedChatID := getString(cfg, "chat_id")
	if strconv.FormatInt(update.Message.Chat.ID, 10) != expectedChatID {
		return nil, messenger.ErrUnauthorizedWebhook
	}

	botToken := getString(cfg, "bot_token")
	text := strings.TrimSpace(update.Message.Text)
	if text == "" {
		text = strings.TrimSpace(update.Message.Caption)
	}
	cmd, args := messenger.ParseSlashCommand(text)

	ev := &messenger.IncomingEvent{
		Text:    text,
		Command: cmd,
		Args:    args,
	}

	if len(update.Message.Photo) > 0 {
		largest := update.Message.Photo[len(update.Message.Photo)-1]
		fileID := largest.FileID
		ev.Attachments = append(ev.Attachments, messenger.Attachment{
			Type:     "image",
			FileName: "telegram-photo.jpg",
			MimeType: "image/jpeg",
			Size:     largest.FileSize,
			Download: func(dlCtx context.Context, maxBytes int64) ([]byte, error) {
				return d.downloadTelegramFile(dlCtx, botToken, fileID, maxBytes)
			},
		})
	} else if update.Message.Document != nil {
		doc := update.Message.Document
		attType := "file"
		if strings.HasPrefix(strings.ToLower(doc.MimeType), "image/") {
			attType = "image"
		}
		fileID := doc.FileID
		ev.Attachments = append(ev.Attachments, messenger.Attachment{
			Type:     attType,
			FileName: doc.FileName,
			MimeType: doc.MimeType,
			Size:     doc.FileSize,
			Download: func(dlCtx context.Context, maxBytes int64) ([]byte, error) {
				return d.downloadTelegramFile(dlCtx, botToken, fileID, maxBytes)
			},
		})
	}

	return ev, nil
}

func (d *TelegramDriver) downloadTelegramFile(ctx context.Context, botToken, fileID string, maxBytes int64) ([]byte, error) {
	var fileRes struct {
		FilePath string `json:"file_path"`
		FileSize int64  `json:"file_size"`
	}
	if err := d.callAPI(ctx, botToken, "getFile", map[string]any{"file_id": fileID}, &fileRes); err != nil {
		return nil, err
	}
	if maxBytes > 0 && fileRes.FileSize > maxBytes {
		return nil, fmt.Errorf("文件超出服务器中转大小上限 (%d MB)", maxBytes/(1<<20))
	}

	url := fmt.Sprintf("%s/file/bot%s/%s", strings.TrimRight(d.APIBaseURL, "/"), botToken, fileRes.FilePath)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := d.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download telegram file: status %d", resp.StatusCode)
	}

	var reader io.Reader = resp.Body
	if maxBytes > 0 {
		reader = io.LimitReader(resp.Body, maxBytes+1)
	}
	data, err := io.ReadAll(reader)
	if err != nil {
		return nil, err
	}
	if maxBytes > 0 && int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("文件超出服务器中转大小上限 (%d MB)", maxBytes/(1<<20))
	}
	return data, nil
}

func (d *TelegramDriver) callAPI(ctx context.Context, botToken, method string, payload any, outResult any) error {
	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	endpoint := fmt.Sprintf("%s/bot%s/%s", strings.TrimRight(d.APIBaseURL, "/"), botToken, method)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := d.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	// Guardrail: cap response read size to 1MB.
	respBytes, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}

	var apiResp struct {
		OK          bool            `json:"ok"`
		Description string          `json:"description"`
		Result      json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(respBytes, &apiResp); err != nil {
		return fmt.Errorf("telegram %s invalid response (status %d)", method, resp.StatusCode)
	}
	if !apiResp.OK {
		return fmt.Errorf("telegram %s: %s", method, apiResp.Description)
	}
	if outResult != nil && len(apiResp.Result) > 0 {
		if err := json.Unmarshal(apiResp.Result, outResult); err != nil {
			return err
		}
	}
	return nil
}

func getString(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	v, ok := m[key]
	if !ok || v == nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return strings.TrimSpace(t)
	case float64:
		return strconv.FormatInt(int64(t), 10)
	default:
		return strings.TrimSpace(fmt.Sprint(t))
	}
}
