package storage

type ConfigView struct {
	Configured     bool   `json:"configured"`
	Endpoint       string `json:"endpoint"`
	Region         string `json:"region"`
	Bucket         string `json:"bucket"`
	AccessKey      string `json:"access_key"`
	HasSecretKey   bool   `json:"has_secret_key"`
	SecretKeyMask  string `json:"secret_key_masked"`
	PublicBaseURL  string `json:"public_base_url"`
	HashLength     int    `json:"hash_length"`
	ForcePathStyle bool   `json:"force_path_style"`
	UploadMode     string `json:"upload_mode" tstype:"'direct' | 'proxy'"`
	ProxyMaxMB     int64  `json:"proxy_max_mb"` // Server guardrail (only applies to proxy mode & bot media)
}

type SaveConfigInput struct {
	Endpoint       string `json:"endpoint"`
	Region         string `json:"region"`
	Bucket         string `json:"bucket"`
	AccessKey      string `json:"access_key"`
	SecretKey      string `json:"secret_key"`
	PublicBaseURL  string `json:"public_base_url"`
	HashLength     int    `json:"hash_length"`
	ForcePathStyle bool   `json:"force_path_style"`
	UploadMode     string `json:"upload_mode" tstype:"'direct' | 'proxy'"`
}

type FolderEntry struct {
	Name   string `json:"name"`
	Prefix string `json:"prefix"`
}

type FileEntry struct {
	Key              string `json:"key"`
	Name             string `json:"name"`
	Size             int64  `json:"size"`
	Uploaded         string `json:"uploaded"`
	ContentType      string `json:"content_type"`
	URL              string `json:"url"`
	IsImage          bool   `json:"is_image"`
	MetadataStripped bool   `json:"metadata_stripped"`
}

type DirectoryListing struct {
	Prefix    string        `json:"prefix"`
	BaseURL   string        `json:"base_url"`
	Folders   []FolderEntry `json:"folders"`
	Files     []FileEntry   `json:"files"`
	Truncated bool          `json:"truncated"`
	Cursor    string        `json:"cursor,omitempty"`
}

type PresignInput struct {
	Folder      string `json:"folder"`
	FileName    string `json:"file_name"`
	ContentType string `json:"content_type"`
	SHA256      string `json:"sha256"`
	Stripped    bool   `json:"stripped"`
}

type PresignedPut struct {
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
}

type PresignResult struct {
	PresignedPut `tstype:",extends"`
	File         FileEntry `json:"file"`
}

type PathItem struct {
	Type string `json:"type" tstype:"'file' | 'folder'"`
	Path string `json:"path"`
}

type CreateFolderInput struct {
	Path string `json:"path"`
}

type RenameEntryInput struct {
	Type    string `json:"type" tstype:"'file' | 'folder'"`
	OldPath string `json:"oldPath"`
	NewPath string `json:"newPath"`
}

type RenameEntryResponse struct {
	OK         bool   `json:"ok"`
	OldPath    string `json:"oldPath"`
	NewPath    string `json:"newPath"`
	MovedCount int    `json:"movedCount"`
	URL        string `json:"url,omitempty"`
}

type MoveEntriesInput struct {
	Items        []PathItem `json:"items"`
	TargetFolder string     `json:"targetFolder"`
}

type DeleteEntriesInput struct {
	Type  string     `json:"type,omitempty" tstype:"'file' | 'folder'"`
	Path  string     `json:"path,omitempty"`
	Items []PathItem `json:"items,omitempty"`
}
