package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"yukideck/internal/core/crypto"
	"yukideck/internal/core/httpx"
)

const (
	UploadModeDirect = "direct"
	UploadModeProxy  = "proxy"
)

type PlainConfig struct {
	Endpoint       string
	Region         string
	Bucket         string
	AccessKey      string
	SecretKey      string
	PublicBaseURL  string
	HashLength     int
	ForcePathStyle bool
	UploadMode     string
}

type Service struct {
	store      ConfigStore
	box        *crypto.Box
	factory    BucketFactory
	proxyMaxMB int64
}

func NewService(store ConfigStore, box *crypto.Box, factory BucketFactory, proxyMaxMB int64) *Service {
	if proxyMaxMB <= 0 {
		proxyMaxMB = 20
	}
	return &Service{
		store:      store,
		box:        box,
		factory:    factory,
		proxyMaxMB: proxyMaxMB,
	}
}

func (s *Service) ProxyMaxBytes() int64 {
	return s.proxyMaxMB * (1 << 20)
}

func (s *Service) GetConfig(ctx context.Context, userID int64) (*ConfigView, error) {
	rec, err := s.store.GetConfig(ctx, userID)
	if err != nil {
		return nil, httpx.Internal("查询图床配置失败", err)
	}
	if rec == nil {
		return &ConfigView{
			Configured: false,
			Region:     "auto",
			HashLength: 16,
			UploadMode: UploadModeDirect,
			ProxyMaxMB: s.proxyMaxMB,
		}, nil
	}
	return s.toConfigView(*rec)
}

func (s *Service) SaveConfig(ctx context.Context, userID int64, in SaveConfigInput) (*ConfigView, error) {
	endpoint := strings.TrimRight(strings.TrimSpace(in.Endpoint), "/")
	region := strings.TrimSpace(in.Region)
	if region == "" {
		region = "auto"
	}
	bucket := strings.TrimSpace(in.Bucket)
	accessKey := strings.TrimSpace(in.AccessKey)
	secretKey := strings.TrimSpace(in.SecretKey)
	publicBaseURL := strings.TrimRight(strings.TrimSpace(in.PublicBaseURL), "/")

	if endpoint == "" || bucket == "" || accessKey == "" || publicBaseURL == "" {
		return nil, httpx.BadRequest("Endpoint、Bucket、AccessKey 与公开访问 URL 均为必填项")
	}

	existing, err := s.store.GetConfig(ctx, userID)
	if err != nil {
		return nil, httpx.Internal("查询已有配置失败", err)
	}

	var secretEnc string
	if secretKey != "" {
		secretEnc, err = s.box.Encrypt([]byte(secretKey))
		if err != nil {
			return nil, httpx.Internal("加密 SecretKey 失败", err)
		}
	} else if existing != nil && existing.SecretKeyEnc != "" {
		secretEnc = existing.SecretKeyEnc
	} else {
		return nil, httpx.BadRequest("首次配置必须填写 SecretKey")
	}

	hashLen := in.HashLength
	if hashLen == 0 {
		hashLen = 16
	}
	if hashLen < 8 || hashLen > 64 {
		return nil, httpx.BadRequest("Hash 长度范围需在 8 到 64 之间")
	}

	mode := strings.ToLower(strings.TrimSpace(in.UploadMode))
	if mode == "" {
		mode = UploadModeDirect
	}
	if mode != UploadModeDirect && mode != UploadModeProxy {
		return nil, httpx.BadRequest("upload_mode 仅支持 direct 或 proxy")
	}

	saved, err := s.store.UpsertConfig(ctx, ConfigRecord{
		UserID:         userID,
		Endpoint:       endpoint,
		Region:         region,
		Bucket:         bucket,
		AccessKey:      accessKey,
		SecretKeyEnc:   secretEnc,
		PublicBaseURL:  publicBaseURL,
		HashLength:     hashLen,
		ForcePathStyle: in.ForcePathStyle,
		UploadMode:     mode,
	})
	if err != nil {
		return nil, httpx.Internal("保存图床配置失败", err)
	}
	return s.toConfigView(*saved)
}

func (s *Service) TestConnection(ctx context.Context, userID int64) error {
	b, _, err := s.userBucket(ctx, userID)
	if err != nil {
		return err
	}
	if err := b.TestConnection(ctx); err != nil {
		return httpx.BadRequest(err.Error())
	}
	return nil
}

func (s *Service) ListDirectory(ctx context.Context, userID int64, rawPrefix, cursor string) (*DirectoryListing, error) {
	b, cfg, err := s.userBucket(ctx, userID)
	if err != nil {
		return nil, err
	}
	prefix, err := NormalizeFolderPrefix(rawPrefix)
	if err != nil {
		return nil, httpx.BadRequest(err.Error())
	}

	listed, err := b.List(ctx, prefix, "/", cursor, 500)
	if err != nil {
		return nil, httpx.BadRequest("读取存储桶目录失败: " + err.Error())
	}

	folders := make([]FolderEntry, 0, len(listed.CommonPrefixes))
	for _, fp := range listed.CommonPrefixes {
		rel := strings.TrimRight(strings.TrimPrefix(fp, prefix), "/")
		if rel == "" {
			continue
		}
		folders = append(folders, FolderEntry{Name: rel, Prefix: fp})
	}
	sort.Slice(folders, func(i, j int) bool { return folders[i].Name < folders[j].Name })

	files := make([]FileEntry, 0, len(listed.Objects))
	for _, obj := range listed.Objects {
		if obj.Key == prefix || strings.HasSuffix(obj.Key, "/") {
			continue
		}
		name := strings.TrimPrefix(obj.Key, prefix)
		if name == "" || name == FolderKeepFilename || strings.Contains(name, "/") {
			continue
		}
		ct := ResolveContentType(obj.ContentType, name)
		files = append(files, FileEntry{
			Key:              obj.Key,
			Name:             name,
			Size:             obj.Size,
			Uploaded:         obj.LastModified.UTC().Format(time.RFC3339),
			ContentType:      ct,
			URL:              BuildPublicURL(cfg.PublicBaseURL, obj.Key),
			IsImage:          IsImageFile(ct, name),
			MetadataStripped: obj.Metadata["stripped"] == "true",
		})
	}
	sort.Slice(files, func(i, j int) bool {
		if files[i].Uploaded != files[j].Uploaded {
			return files[i].Uploaded > files[j].Uploaded
		}
		return files[i].Name < files[j].Name
	})

	return &DirectoryListing{
		Prefix:    prefix,
		BaseURL:   cfg.PublicBaseURL,
		Folders:   folders,
		Files:     files,
		Truncated: listed.Truncated,
		Cursor:    listed.NextCursor,
	}, nil
}

func (s *Service) ListSubfolders(ctx context.Context, userID int64, rawPrefix string) (string, []FolderEntry, error) {
	b, _, err := s.userBucket(ctx, userID)
	if err != nil {
		return "", nil, err
	}
	prefix, err := NormalizeFolderPrefix(rawPrefix)
	if err != nil {
		return "", nil, httpx.BadRequest(err.Error())
	}
	listed, err := b.List(ctx, prefix, "/", "", 1000)
	if err != nil {
		return "", nil, httpx.BadRequest("读取子目录失败: " + err.Error())
	}
	folders := make([]FolderEntry, 0, len(listed.CommonPrefixes))
	for _, fp := range listed.CommonPrefixes {
		rel := strings.TrimRight(strings.TrimPrefix(fp, prefix), "/")
		if rel != "" {
			folders = append(folders, FolderEntry{Name: rel, Prefix: fp})
		}
	}
	sort.Slice(folders, func(i, j int) bool { return folders[i].Name < folders[j].Name })
	return prefix, folders, nil
}

func (s *Service) CreateFolder(ctx context.Context, userID int64, rawPath string) (*FolderEntry, error) {
	b, _, err := s.userBucket(ctx, userID)
	if err != nil {
		return nil, err
	}
	prefix, err := NormalizeFolderPrefix(rawPath)
	if err != nil {
		return nil, httpx.BadRequest(err.Error())
	}
	if prefix == "" {
		return nil, httpx.BadRequest("文件夹名称不能为空")
	}
	keepKey := prefix + FolderKeepFilename
	if err := b.Put(ctx, keepKey, []byte{}, "application/x-empty", nil); err != nil {
		return nil, httpx.BadRequest("创建文件夹失败: " + err.Error())
	}
	parts := strings.Split(strings.TrimRight(prefix, "/"), "/")
	return &FolderEntry{
		Name:   parts[len(parts)-1],
		Prefix: prefix,
	}, nil
}

// PresignDirectUpload generates a 5-minute S3 Presigned PUT URL for direct browser uploads.
// Direct uploads do NOT consume server bandwidth or memory, so NO file size limit is imposed.
func (s *Service) PresignDirectUpload(ctx context.Context, userID int64, in PresignInput) (*PresignResult, error) {
	b, cfg, err := s.userBucket(ctx, userID)
	if err != nil {
		return nil, err
	}
	prefix, err := NormalizeFolderPrefix(in.Folder)
	if err != nil {
		return nil, httpx.BadRequest(err.Error())
	}
	fileName := strings.TrimSpace(in.FileName)
	if fileName == "" || strings.ContainsAny(fileName, `/\`) || fileName == "." || fileName == ".." {
		return nil, httpx.BadRequest("文件名无效")
	}
	key, err := NormalizeObjectKey(prefix + fileName)
	if err != nil {
		return nil, httpx.BadRequest(err.Error())
	}
	ct := ResolveContentType(in.ContentType, fileName)

	meta := map[string]string{}
	if strings.TrimSpace(in.SHA256) != "" {
		meta["sha256"] = strings.TrimSpace(in.SHA256)
	}
	if in.Stripped {
		meta["stripped"] = "true"
	}

	presigned, err := b.PresignPut(ctx, key, ct, meta, 5*time.Minute)
	if err != nil {
		return nil, httpx.Internal("签发直传 URL 失败", err)
	}

	return &PresignResult{
		PresignedPut: *presigned,
		File: FileEntry{
			Key:              key,
			Name:             fileName,
			Uploaded:         time.Now().UTC().Format(time.RFC3339),
			ContentType:      ct,
			URL:              BuildPublicURL(cfg.PublicBaseURL, key),
			IsImage:          IsImageFile(ct, fileName),
			MetadataStripped: in.Stripped,
		},
	}, nil
}

// ProxyUpload handles uploads passing through the server (proxy mode and Telegram bot media).
func (s *Service) ProxyUpload(
	ctx context.Context,
	userID int64,
	data []byte,
	originalName string,
	contentType string,
	folderPrefix string,
	customFileName string,
	alreadyStripped bool,
) (*FileEntry, error) {
	if int64(len(data)) > s.ProxyMaxBytes() {
		return nil, httpx.PayloadTooLarge(fmt.Sprintf("中转上传文件超过服务器安全上限 (%d MB)", s.proxyMaxMB))
	}
	if len(data) == 0 {
		return nil, httpx.BadRequest("上传文件内容为空")
	}
	b, cfg, err := s.userBucket(ctx, userID)
	if err != nil {
		return nil, err
	}
	prefix, err := NormalizeFolderPrefix(folderPrefix)
	if err != nil {
		return nil, httpx.BadRequest(err.Error())
	}

	ext := GetLowerExtension(originalName)
	if ext == "" {
		ext = GuessExtensionFromMime(contentType)
	}
	ct := ResolveContentType(contentType, "file"+ext)

	cleanData := data
	stripped := alreadyStripped
	if !alreadyStripped {
		res := StripImageMetadata(data)
		cleanData = res.Data
		stripped = res.Stripped
	}

	sum := sha256.Sum256(cleanData)
	fullHash := hex.EncodeToString(sum[:])
	hashLen := cfg.HashLength
	if hashLen < 8 || hashLen > 64 {
		hashLen = 16
	}

	var fileName string
	if c := strings.TrimSpace(customFileName); c != "" {
		if strings.ContainsAny(c, `/\`) || c == "." || c == ".." {
			return nil, httpx.BadRequest("文件名不能包含路径分隔符")
		}
		fileName = c
	} else {
		fileName = fullHash[:hashLen] + ext
	}

	key, err := NormalizeObjectKey(prefix + fileName)
	if err != nil {
		return nil, httpx.BadRequest(err.Error())
	}

	meta := map[string]string{
		"sha256":   fullHash,
		"stripped": fmt.Sprintf("%t", stripped),
	}
	if err := b.Put(ctx, key, cleanData, ct, meta); err != nil {
		return nil, httpx.BadRequest("上传到对象存储失败: " + err.Error())
	}

	return &FileEntry{
		Key:              key,
		Name:             fileName,
		Size:             int64(len(cleanData)),
		Uploaded:         time.Now().UTC().Format(time.RFC3339),
		ContentType:      ct,
		URL:              BuildPublicURL(cfg.PublicBaseURL, key),
		IsImage:          IsImageFile(ct, fileName),
		MetadataStripped: stripped,
	}, nil
}

func (s *Service) RenameEntry(ctx context.Context, userID int64, entryType, oldPath, newPath string) (string, string, int, string, error) {
	b, cfg, err := s.userBucket(ctx, userID)
	if err != nil {
		return "", "", 0, "", err
	}

	if entryType == "file" {
		oldKey, err := NormalizeObjectKey(oldPath)
		if err != nil {
			return "", "", 0, "", httpx.BadRequest(err.Error())
		}
		newKey, err := NormalizeObjectKey(newPath)
		if err != nil {
			return "", "", 0, "", httpx.BadRequest(err.Error())
		}
		if oldKey == newKey {
			return oldKey, newKey, 0, BuildPublicURL(cfg.PublicBaseURL, newKey), nil
		}
		existing, err := b.Head(ctx, newKey)
		if err != nil {
			return "", "", 0, "", httpx.BadRequest("检查目标文件失败: " + err.Error())
		}
		if existing != nil {
			return "", "", 0, "", httpx.Conflict("目标名称已存在: " + newKey)
		}
		ct := ""
		if GetLowerExtension(oldKey) != GetLowerExtension(newKey) {
			ct = ResolveContentType("", newKey)
		}
		if err := b.Copy(ctx, oldKey, newKey, ct); err != nil {
			return "", "", 0, "", httpx.BadRequest("重命名文件失败: " + err.Error())
		}
		if err := b.Delete(ctx, []string{oldKey}); err != nil {
			return "", "", 0, "", httpx.BadRequest("删除原文件失败: " + err.Error())
		}
		return oldKey, newKey, 1, BuildPublicURL(cfg.PublicBaseURL, newKey), nil
	}

	if entryType != "folder" {
		return "", "", 0, "", httpx.BadRequest(`type 必须为 "file" 或 "folder"`)
	}

	oldPrefix, err := NormalizeFolderPrefix(oldPath)
	if err != nil {
		return "", "", 0, "", httpx.BadRequest(err.Error())
	}
	newPrefix, err := NormalizeFolderPrefix(newPath)
	if err != nil {
		return "", "", 0, "", httpx.BadRequest(err.Error())
	}
	if oldPrefix == "" || newPrefix == "" {
		return "", "", 0, "", httpx.BadRequest("根目录不支持重命名")
	}
	if oldPrefix == newPrefix {
		return oldPrefix, newPrefix, 0, "", nil
	}
	if strings.HasPrefix(newPrefix, oldPrefix) {
		return "", "", 0, "", httpx.BadRequest("不能将文件夹移动到其自身的子目录中")
	}

	checkTarget, err := b.List(ctx, newPrefix, "", "", 1)
	if err != nil {
		return "", "", 0, "", httpx.BadRequest("检查目标文件夹失败: " + err.Error())
	}
	if len(checkTarget.Objects) > 0 {
		return "", "", 0, "", httpx.Conflict("目标文件夹已存在: " + strings.TrimRight(newPrefix, "/"))
	}

	allObjects, err := listAllByPrefix(ctx, b, oldPrefix)
	if err != nil {
		return "", "", 0, "", httpx.BadRequest("列举源文件夹失败: " + err.Error())
	}
	if len(allObjects) == 0 {
		if err := b.Put(ctx, newPrefix+FolderKeepFilename, []byte{}, "application/x-empty", nil); err != nil {
			return "", "", 0, "", httpx.BadRequest("创建目标文件夹失败: " + err.Error())
		}
		return oldPrefix, newPrefix, 1, "", nil
	}

	var (
		mu       sync.Mutex
		toDelete []string
	)
	err = runConcurrent(allObjects, 16, func(obj S3Object) error {
		rel := strings.TrimPrefix(obj.Key, oldPrefix)
		targetKey := newPrefix + rel
		if err := b.Copy(ctx, obj.Key, targetKey, ""); err != nil {
			return err
		}
		mu.Lock()
		toDelete = append(toDelete, obj.Key)
		mu.Unlock()
		return nil
	})
	if err != nil {
		return "", "", 0, "", httpx.BadRequest("迁移文件夹内容失败: " + err.Error())
	}
	if len(toDelete) > 0 {
		if err := b.Delete(ctx, toDelete); err != nil {
			return "", "", 0, "", httpx.BadRequest("清理原文件夹失败: " + err.Error())
		}
	}
	return oldPrefix, newPrefix, len(toDelete), "", nil
}

func (s *Service) MoveEntries(ctx context.Context, userID int64, items []PathItem, targetFolder string) (int, error) {
	if len(items) == 0 {
		return 0, httpx.BadRequest("请选择要移动的项目")
	}
	b, _, err := s.userBucket(ctx, userID)
	if err != nil {
		return 0, err
	}
	targetPrefix, err := NormalizeFolderPrefix(targetFolder)
	if err != nil {
		return 0, httpx.BadRequest(err.Error())
	}

	type pair struct{ oldKey, newKey string }
	var filePairs []pair
	var folderTasks []pair

	for _, item := range items {
		switch item.Type {
		case "file":
			oldKey, err := NormalizeObjectKey(item.Path)
			if err != nil {
				return 0, httpx.BadRequest(err.Error())
			}
			parts := strings.Split(oldKey, "/")
			newKey := targetPrefix + parts[len(parts)-1]
			if oldKey != newKey {
				filePairs = append(filePairs, pair{oldKey: oldKey, newKey: newKey})
			}
		case "folder":
			oldPrefix, err := NormalizeFolderPrefix(item.Path)
			if err != nil {
				return 0, httpx.BadRequest(err.Error())
			}
			if oldPrefix == "" {
				continue
			}
			parts := strings.Split(strings.TrimRight(oldPrefix, "/"), "/")
			newPrefix := targetPrefix + parts[len(parts)-1] + "/"
			if oldPrefix != newPrefix {
				folderTasks = append(folderTasks, pair{oldKey: oldPrefix, newKey: newPrefix})
			}
		}
	}

	totalMoved := 0
	if len(filePairs) > 0 {
		var (
			mu       sync.Mutex
			toDelete []string
		)
		err := runConcurrent(filePairs, 16, func(p pair) error {
			existing, err := b.Head(ctx, p.newKey)
			if err != nil {
				return err
			}
			if existing != nil {
				return fmt.Errorf("目标位置已存在同名文件: %s", p.newKey)
			}
			if err := b.Copy(ctx, p.oldKey, p.newKey, ""); err != nil {
				return err
			}
			mu.Lock()
			toDelete = append(toDelete, p.oldKey)
			mu.Unlock()
			return nil
		})
		if err != nil {
			return totalMoved, httpx.BadRequest(err.Error())
		}
		if len(toDelete) > 0 {
			if err := b.Delete(ctx, toDelete); err != nil {
				return totalMoved, httpx.BadRequest("清理原文件失败: " + err.Error())
			}
			totalMoved += len(toDelete)
		}
	}

	for _, f := range folderTasks {
		_, _, moved, _, err := s.RenameEntry(ctx, userID, "folder", f.oldKey, f.newKey)
		if err != nil {
			return totalMoved, err
		}
		totalMoved += moved
	}
	return totalMoved, nil
}

func (s *Service) DeleteEntries(ctx context.Context, userID int64, items []PathItem) (int, error) {
	if len(items) == 0 {
		return 0, httpx.BadRequest("请选择要删除的项目")
	}
	b, _, err := s.userBucket(ctx, userID)
	if err != nil {
		return 0, err
	}

	var keys []string
	for _, item := range items {
		switch item.Type {
		case "file":
			key, err := NormalizeObjectKey(item.Path)
			if err != nil {
				return 0, httpx.BadRequest(err.Error())
			}
			keys = append(keys, key)
		case "folder":
			prefix, err := NormalizeFolderPrefix(item.Path)
			if err != nil {
				return 0, httpx.BadRequest(err.Error())
			}
			if prefix == "" {
				return 0, httpx.BadRequest("不能直接删除根目录")
			}
			objs, err := listAllByPrefix(ctx, b, prefix)
			if err != nil {
				return 0, httpx.BadRequest("列举文件夹失败: " + err.Error())
			}
			for _, o := range objs {
				keys = append(keys, o.Key)
			}
		default:
			return 0, httpx.BadRequest(`type 必须为 "file" 或 "folder"`)
		}
	}

	if len(keys) > 0 {
		if err := b.Delete(ctx, keys); err != nil {
			return 0, httpx.BadRequest("删除对象失败: " + err.Error())
		}
	}
	return len(keys), nil
}

// --- Helpers ---

func (s *Service) userBucket(ctx context.Context, userID int64) (Bucket, *PlainConfig, error) {
	rec, err := s.store.GetConfig(ctx, userID)
	if err != nil {
		return nil, nil, httpx.Internal("读取图床配置失败", err)
	}
	if rec == nil {
		return nil, nil, httpx.BadRequest("请先在「系统设置 -> 图床对象存储」中配置你自己的 S3/R2 存储桶")
	}
	secretBytes, err := s.box.Decrypt(rec.SecretKeyEnc)
	if err != nil {
		return nil, nil, httpx.Internal("解密 SecretKey 失败", err)
	}
	plain := &PlainConfig{
		Endpoint:       rec.Endpoint,
		Region:         rec.Region,
		Bucket:         rec.Bucket,
		AccessKey:      rec.AccessKey,
		SecretKey:      string(secretBytes),
		PublicBaseURL:  rec.PublicBaseURL,
		HashLength:     rec.HashLength,
		ForcePathStyle: rec.ForcePathStyle,
		UploadMode:     rec.UploadMode,
	}
	b, err := s.factory(*plain)
	if err != nil {
		return nil, nil, httpx.Internal("初始化对象存储客户端失败", err)
	}
	return b, plain, nil
}

func (s *Service) toConfigView(rec ConfigRecord) (*ConfigView, error) {
	secretBytes, err := s.box.Decrypt(rec.SecretKeyEnc)
	if err != nil {
		return nil, httpx.Internal("解密 SecretKey 失败", err)
	}
	secret := string(secretBytes)
	mask := ""
	if len(secret) > 8 {
		mask = secret[:4] + "****" + secret[len(secret)-4:]
	} else if secret != "" {
		mask = "****"
	}
	return &ConfigView{
		Configured:     true,
		Endpoint:       rec.Endpoint,
		Region:         rec.Region,
		Bucket:         rec.Bucket,
		AccessKey:      rec.AccessKey,
		HasSecretKey:   secret != "",
		SecretKeyMask:  mask,
		PublicBaseURL:  rec.PublicBaseURL,
		HashLength:     rec.HashLength,
		ForcePathStyle: rec.ForcePathStyle,
		UploadMode:     rec.UploadMode,
		ProxyMaxMB:     s.proxyMaxMB,
	}, nil
}

func listAllByPrefix(ctx context.Context, b Bucket, prefix string) ([]S3Object, error) {
	var all []S3Object
	cursor := ""
	for {
		res, err := b.List(ctx, prefix, "", cursor, 1000)
		if err != nil {
			return nil, err
		}
		all = append(all, res.Objects...)
		if !res.Truncated || res.NextCursor == "" {
			break
		}
		cursor = res.NextCursor
	}
	return all, nil
}

func runConcurrent[T any](items []T, concurrency int, fn func(T) error) error {
	if len(items) == 0 {
		return nil
	}
	if concurrency > len(items) {
		concurrency = len(items)
	}
	ch := make(chan T, len(items))
	for _, it := range items {
		ch <- it
	}
	close(ch)

	var (
		wg       sync.WaitGroup
		errMu    sync.Mutex
		firstErr error
	)
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for item := range ch {
				errMu.Lock()
				hasErr := firstErr != nil
				errMu.Unlock()
				if hasErr {
					return
				}
				if err := fn(item); err != nil {
					errMu.Lock()
					if firstErr == nil {
						firstErr = err
					}
					errMu.Unlock()
					return
				}
			}
		}()
	}
	wg.Wait()
	return firstErr
}
