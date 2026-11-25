package auth

type User struct {
	ID        int64  `json:"id"`
	OIDCSub   string `json:"-"`
	Username  string `json:"username"`
	Email     string `json:"email"`
	AvatarURL string `json:"avatar_url"`
}
