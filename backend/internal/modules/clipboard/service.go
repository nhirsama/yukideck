package clipboard

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"yukideck/internal/core/httpx"
)

const (
	DefaultMaxBytes       int64 = 256 * 1024 // 256 KiB
	DefaultTTL                  = 24 * time.Hour
	MaxTTLDays                  = 365
	SSEInlineMaxBytes     int64 = 64 * 1024 // 64 KiB
	ListInlineMaxBytes          = 32 * 1024 // 32 KiB
	PreviewMaxRunes             = 600
	expiryClockSkewBuffer       = time.Minute
)

// Record is the persistence model stored in clipboard_items.
type Record struct {
	ID        int64
	UserID    int64
	Content   string
	ByteSize  int
	Starred   bool
	SortOrder int
	Version   int64
	ExpiresAt time.Time
	CreatedAt time.Time
	UpdatedAt time.Time
}

type ListQuery struct {
	Q           string
	StarredOnly bool
	SortBy      string
	SortDir     string
}

type Service struct {
	store    Store
	hub      *Hub
	maxBytes int64
	logger   *slog.Logger
	nowFn    func() time.Time
}

func NewService(store Store, hub *Hub, maxBytes int64, logger *slog.Logger) *Service {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBytes
	}
	if hub == nil {
		hub = NewHub()
	}
	return &Service{
		store:    store,
		hub:      hub,
		maxBytes: maxBytes,
		logger:   logger,
		nowFn:    func() time.Time { return time.Now().UTC() },
	}
}

func (s *Service) Hub() *Hub {
	return s.hub
}

func (s *Service) Meta() ClipboardMeta {
	return ClipboardMeta{
		MaxBytes:          s.maxBytes,
		DefaultTTLSeconds: int64(DefaultTTL.Seconds()),
		MaxTTLDays:        MaxTTLDays,
		SSEInlineMaxBytes: SSEInlineMaxBytes,
	}
}

func (s *Service) ListItems(ctx context.Context, userID int64, q ListQuery) (*ListItemsResponse, error) {
	now := s.nowFn()
	rows, err := s.store.ListActiveItems(ctx, userID, now)
	if err != nil {
		return nil, httpx.Internal("查询剪切板列表失败", err)
	}

	keyword := strings.ToLower(strings.TrimSpace(q.Q))
	filtered := make([]Record, 0, len(rows))
	for _, r := range rows {
		if q.StarredOnly && !r.Starred {
			continue
		}
		if keyword != "" && !strings.Contains(strings.ToLower(r.Content), keyword) {
			continue
		}
		filtered = append(filtered, r)
	}

	sortRecords(filtered, q.SortBy, q.SortDir)

	items := make([]ClipboardItem, 0, len(filtered))
	for _, r := range filtered {
		items = append(items, toDTO(r, true))
	}
	return &ListItemsResponse{
		Items: items,
		Total: len(items),
	}, nil
}

func (s *Service) GetItem(ctx context.Context, userID, id int64) (*ClipboardItem, error) {
	now := s.nowFn()
	rec, err := s.store.GetActiveItem(ctx, userID, id, now)
	if err != nil {
		return nil, httpx.Internal("查询剪切板内容失败", err)
	}
	if rec == nil {
		return nil, httpx.NotFound("剪切板条目不存在或已过期")
	}
	item := toDTO(*rec, false)
	return &item, nil
}

func (s *Service) CreateItem(ctx context.Context, userID int64, in CreateItemInput) (*ClipboardItem, error) {
	now := s.nowFn()
	if err := s.validateContent(in.Content, true); err != nil {
		return nil, err
	}
	expiresAt, err := parseAndValidateExpiry(in.ExpiresAt, now, true)
	if err != nil {
		return nil, err
	}

	minSort, err := s.store.GetMinSortOrder(ctx, userID, now)
	if err != nil {
		return nil, httpx.Internal("计算排序位置失败", err)
	}

	starred := false
	if in.Starred != nil {
		starred = *in.Starred
	}

	rec, err := s.store.CreateItem(ctx, Record{
		UserID:    userID,
		Content:   in.Content,
		ByteSize:  len(in.Content),
		Starred:   starred,
		SortOrder: minSort - 1,
		ExpiresAt: expiresAt,
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		return nil, httpx.Internal("创建剪切板条目失败", err)
	}

	item := toDTO(*rec, false)
	s.broadcastItemEvent(userID, "created", in.ClientID, false, item)
	return &item, nil
}

func (s *Service) UpdateItem(ctx context.Context, userID, id int64, in UpdateItemInput) (*ClipboardItem, error) {
	now := s.nowFn()
	if err := s.validateContent(in.Content, false); err != nil {
		return nil, err
	}

	existing, err := s.store.GetActiveItem(ctx, userID, id, now)
	if err != nil {
		return nil, httpx.Internal("查询剪切板条目失败", err)
	}
	if existing == nil {
		return nil, httpx.NotFound("剪切板条目不存在或已过期")
	}

	starred := existing.Starred
	if in.Starred != nil {
		starred = *in.Starred
	}

	expiresAt := existing.ExpiresAt
	if in.ExpiresAt != nil {
		parsed, parseErr := parseAndValidateExpiry(in.ExpiresAt, now, false)
		if parseErr != nil {
			return nil, parseErr
		}
		expiresAt = parsed
	}

	var updated *Record
	if !in.Force && in.ExpectedVersion != nil && *in.ExpectedVersion > 0 {
		updated, err = s.store.UpdateItemContentWithVersion(ctx, userID, id, *in.ExpectedVersion, in.Content, len(in.Content), starred, expiresAt, now)
		if err != nil {
			return nil, httpx.Internal("保存剪切板内容失败", err)
		}
		if updated == nil {
			// Distinguish expired/deleted vs version conflict.
			latest, checkErr := s.store.GetActiveItem(ctx, userID, id, now)
			if checkErr != nil {
				return nil, httpx.Internal("校验剪切板版本失败", checkErr)
			}
			if latest == nil {
				return nil, httpx.NotFound("剪切板条目不存在或已过期")
			}
			return nil, &httpx.AppError{
				Status:  http.StatusConflict,
				Code:    "version_conflict",
				Message: "该条目已在其他设备更新，请刷新最新版本或选择覆盖",
			}
		}
	} else {
		updated, err = s.store.UpdateItemContentForce(ctx, userID, id, in.Content, len(in.Content), starred, expiresAt, now)
		if err != nil {
			return nil, httpx.Internal("保存剪切板内容失败", err)
		}
		if updated == nil {
			return nil, httpx.NotFound("剪切板条目不存在或已过期")
		}
	}

	item := toDTO(*updated, false)
	s.broadcastItemEvent(userID, "updated", in.ClientID, false, item)
	return &item, nil
}

func (s *Service) PatchItem(ctx context.Context, userID, id int64, in PatchItemInput) (*ClipboardItem, error) {
	now := s.nowFn()
	if in.Starred == nil && in.ExpiresAt == nil {
		return nil, httpx.BadRequest("请提供需要更新的字段")
	}

	existing, err := s.store.GetActiveItem(ctx, userID, id, now)
	if err != nil {
		return nil, httpx.Internal("查询剪切板条目失败", err)
	}
	if existing == nil {
		return nil, httpx.NotFound("剪切板条目不存在或已过期")
	}

	starred := existing.Starred
	if in.Starred != nil {
		starred = *in.Starred
	}

	expiresAt := existing.ExpiresAt
	if in.ExpiresAt != nil {
		parsed, parseErr := parseAndValidateExpiry(in.ExpiresAt, now, false)
		if parseErr != nil {
			return nil, parseErr
		}
		expiresAt = parsed
	}

	updated, err := s.store.UpdateItemMeta(ctx, userID, id, starred, expiresAt, now)
	if err != nil {
		return nil, httpx.Internal("更新剪切板属性失败", err)
	}
	if updated == nil {
		return nil, httpx.NotFound("剪切板条目不存在或已过期")
	}

	item := toDTO(*updated, false)
	s.broadcastItemEvent(userID, "updated", in.ClientID, true, item)
	return &item, nil
}

func (s *Service) DeleteItem(ctx context.Context, userID, id int64, clientID string) error {
	deleted, err := s.store.DeleteItem(ctx, userID, id)
	if err != nil {
		return httpx.Internal("删除剪切板条目失败", err)
	}
	if !deleted {
		return httpx.NotFound("剪切板条目不存在")
	}
	s.hub.Broadcast(userID, ClipboardEvent{
		Type:     "deleted",
		ItemID:   id,
		ClientID: strings.TrimSpace(clientID),
	})
	return nil
}

func (s *Service) ReorderItems(ctx context.Context, userID int64, in ReorderItemsInput) error {
	if len(in.IDs) == 0 {
		return nil
	}
	now := s.nowFn()
	if err := s.store.ReorderItems(ctx, userID, in.IDs, now); err != nil {
		return httpx.Internal("更新排序失败", err)
	}
	s.hub.Broadcast(userID, ClipboardEvent{
		Type:     "reordered",
		ClientID: strings.TrimSpace(in.ClientID),
	})
	return nil
}

func (s *Service) PurgeExpired(ctx context.Context) (int64, error) {
	n, err := s.store.PurgeExpired(ctx, s.nowFn())
	if err != nil {
		return 0, err
	}
	if n > 0 && s.logger != nil {
		s.logger.Info("purged expired clipboard items", "count", n)
	}
	return n, nil
}

func (s *Service) broadcastItemEvent(userID int64, evType, clientID string, metaOnly bool, item ClipboardItem) {
	ev := ClipboardEvent{
		Type:     evType,
		ItemID:   item.ID,
		ClientID: strings.TrimSpace(clientID),
		Version:  item.Version,
		MetaOnly: metaOnly,
	}
	if metaOnly {
		metaCopy := item
		metaCopy.Content = ""
		metaCopy.ContentOmitted = true
		ev.Item = &metaCopy
	} else if int64(item.ByteSize) <= SSEInlineMaxBytes {
		fullCopy := item
		ev.Item = &fullCopy
	} else {
		ev.FetchRequired = true
	}
	s.hub.Broadcast(userID, ev)
}

func (s *Service) validateContent(content string, requireNonEmpty bool) error {
	if requireNonEmpty && len(content) == 0 {
		return httpx.BadRequest("内容不能为空")
	}
	if int64(len(content)) > s.maxBytes {
		return httpx.PayloadTooLarge(fmt.Sprintf("文本大小超出服务器限制（当前 %s，上限 %s）", formatBytes(int64(len(content))), formatBytes(s.maxBytes)))
	}
	return nil
}

func parseAndValidateExpiry(raw *string, now time.Time, allowDefault bool) (time.Time, error) {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		if allowDefault {
			return now.Add(DefaultTTL), nil
		}
		return time.Time{}, httpx.BadRequest("到期时间不能为空")
	}
	t, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(*raw))
	if err != nil {
		t, err = time.Parse(time.RFC3339, strings.TrimSpace(*raw))
		if err != nil {
			return time.Time{}, httpx.BadRequest("到期时间格式无效，需为 RFC3339 时间")
		}
	}
	t = t.UTC()
	if !t.After(now) {
		return time.Time{}, httpx.BadRequest("到期时间必须晚于当前时间")
	}
	maxAllowed := now.AddDate(1, 0, 0).Add(expiryClockSkewBuffer)
	if t.After(maxAllowed) {
		return time.Time{}, httpx.BadRequest("到期时间最长不能超过 1 年")
	}
	return t, nil
}

func sortRecords(rows []Record, sortBy, sortDir string) {
	field := strings.ToLower(strings.TrimSpace(sortBy))
	switch field {
	case "manual", "updated_at", "created_at", "expires_at":
	default:
		field = "updated_at"
	}

	dir := strings.ToLower(strings.TrimSpace(sortDir))
	if dir != "asc" && dir != "desc" {
		if field == "manual" || field == "expires_at" {
			dir = "asc"
		} else {
			dir = "desc"
		}
	}
	asc := dir == "asc"

	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		// Starred items always float to the top.
		if a.Starred != b.Starred {
			return a.Starred
		}
		var cmp int
		switch field {
		case "manual":
			if a.SortOrder < b.SortOrder {
				cmp = -1
			} else if a.SortOrder > b.SortOrder {
				cmp = 1
			}
		case "created_at":
			cmp = compareTime(a.CreatedAt, b.CreatedAt)
		case "expires_at":
			cmp = compareTime(a.ExpiresAt, b.ExpiresAt)
		default: // updated_at
			cmp = compareTime(a.UpdatedAt, b.UpdatedAt)
		}
		if cmp != 0 {
			if asc {
				return cmp < 0
			}
			return cmp > 0
		}
		return a.ID > b.ID
	})
}

func compareTime(a, b time.Time) int {
	if a.Before(b) {
		return -1
	}
	if a.After(b) {
		return 1
	}
	return 0
}

func toDTO(r Record, compact bool) ClipboardItem {
	charCount := utf8.RuneCountInString(r.Content)
	lineCount := 1
	if r.Content == "" {
		lineCount = 0
	} else {
		lineCount = strings.Count(r.Content, "\n") + 1
	}
	preview := buildPreview(r.Content, PreviewMaxRunes)

	content := r.Content
	omitted := false
	if compact && r.ByteSize > ListInlineMaxBytes {
		content = ""
		omitted = true
	}

	return ClipboardItem{
		ID:             r.ID,
		Content:        content,
		Preview:        preview,
		ContentOmitted: omitted,
		ByteSize:       r.ByteSize,
		CharCount:      charCount,
		LineCount:      lineCount,
		Starred:        r.Starred,
		SortOrder:      r.SortOrder,
		Version:        r.Version,
		ExpiresAt:      r.ExpiresAt.UTC(),
		CreatedAt:      r.CreatedAt.UTC(),
		UpdatedAt:      r.UpdatedAt.UTC(),
	}
}

func buildPreview(s string, maxRunes int) string {
	if utf8.RuneCountInString(s) <= maxRunes {
		return s
	}
	runes := []rune(s)
	return string(runes[:maxRunes])
}

func formatBytes(n int64) string {
	switch {
	case n >= 1024*1024:
		return fmt.Sprintf("%.1f MiB", float64(n)/(1024*1024))
	case n >= 1024:
		return fmt.Sprintf("%.1f KiB", float64(n)/1024)
	default:
		return fmt.Sprintf("%d B", n)
	}
}
