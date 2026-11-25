package ai_usage

import (
	"regexp"
	"sort"
	"strings"
)

var (
	reTagSuffix  = regexp.MustCompile(`:(?:free|beta|extended|thinking|exacto|floor|nitro)$`)
	reDateSuffix = regexp.MustCompile(`(?:[-@](?:20\d{6}|20\d{2}-\d{2}-\d{2})|-v\d+:\d+)$`)
	providerPrefixes = []string{
		"us.anthropic.",
		"eu.anthropic.",
		"apac.anthropic.",
		"global.anthropic.",
		"anthropic.",
		"anthropic/",
		"openai/",
		"google-antigravity/",
		"google-vertex/",
		"google-gemini-cli/",
		"google/",
		"antigravity/",
		"vertex_ai/",
		"vertex/",
		"bedrock/",
		"openrouter/",
		"github-copilot/",
		"opencode/",
		"azure/",
		"deepseek/",
		"x-ai/",
		"xai/",
		"zai-org/",
		"zai/",
		"z-ai/",
		"zhipu/",
		"moonshotai/",
		"moonshot/",
		"kimi/",
		"qwen/",
		"alibaba/",
		"dashscope/",
		"minimax/",
		"models/",
	}
)

type builtinAliasRule struct {
	pattern   string
	canonical string
}

var builtinAliasRules = []builtinAliasRule{
	// Anthropic Claude 5.5 / 5
	{pattern: "claude-opus-5-5*", canonical: "claude-opus-5.5"},
	{pattern: "claude-opus-5.5*", canonical: "claude-opus-5.5"},
	{pattern: "claude-5-5-opus*", canonical: "claude-opus-5.5"},
	{pattern: "claude-5.5-opus*", canonical: "claude-opus-5.5"},
	{pattern: "claude-sonnet-5-5*", canonical: "claude-sonnet-5.5"},
	{pattern: "claude-sonnet-5.5*", canonical: "claude-sonnet-5.5"},
	{pattern: "claude-5-5-sonnet*", canonical: "claude-sonnet-5.5"},
	{pattern: "claude-5.5-sonnet*", canonical: "claude-sonnet-5.5"},
	{pattern: "claude-haiku-5-5*", canonical: "claude-haiku-5.5"},
	{pattern: "claude-haiku-5.5*", canonical: "claude-haiku-5.5"},
	{pattern: "claude-5-5-haiku*", canonical: "claude-haiku-5.5"},
	{pattern: "claude-5.5-haiku*", canonical: "claude-haiku-5.5"},
	{pattern: "claude-opus-5*", canonical: "claude-opus-5"},
	{pattern: "claude-5-opus*", canonical: "claude-opus-5"},
	{pattern: "claude-sonnet-5*", canonical: "claude-sonnet-5"},
	{pattern: "claude-5-sonnet*", canonical: "claude-sonnet-5"},
	{pattern: "claude-haiku-5*", canonical: "claude-haiku-5.5"},
	{pattern: "claude-5-haiku*", canonical: "claude-haiku-5.5"},

	// Anthropic Claude 4.x
	{pattern: "claude-opus-4-7*", canonical: "claude-opus-4.7"},
	{pattern: "claude-opus-4.7*", canonical: "claude-opus-4.7"},
	{pattern: "claude-4-7-opus*", canonical: "claude-opus-4.7"},
	{pattern: "claude-4.7-opus*", canonical: "claude-opus-4.7"},
	{pattern: "claude-sonnet-4-7*", canonical: "claude-sonnet-4.7"},
	{pattern: "claude-sonnet-4.7*", canonical: "claude-sonnet-4.7"},
	{pattern: "claude-4-7-sonnet*", canonical: "claude-sonnet-4.7"},
	{pattern: "claude-4.7-sonnet*", canonical: "claude-sonnet-4.7"},
	{pattern: "claude-opus-4-6*", canonical: "claude-opus-4.6"},
	{pattern: "claude-opus-4.6*", canonical: "claude-opus-4.6"},
	{pattern: "claude-4-6-opus*", canonical: "claude-opus-4.6"},
	{pattern: "claude-4.6-opus*", canonical: "claude-opus-4.6"},
	{pattern: "claude-sonnet-4-6*", canonical: "claude-sonnet-4.6"},
	{pattern: "claude-sonnet-4.6*", canonical: "claude-sonnet-4.6"},
	{pattern: "claude-4-6-sonnet*", canonical: "claude-sonnet-4.6"},
	{pattern: "claude-4.6-sonnet*", canonical: "claude-sonnet-4.6"},
	{pattern: "claude-opus-4-5*", canonical: "claude-opus-4.5"},
	{pattern: "claude-opus-4.5*", canonical: "claude-opus-4.5"},
	{pattern: "claude-4-5-opus*", canonical: "claude-opus-4.5"},
	{pattern: "claude-4.5-opus*", canonical: "claude-opus-4.5"},
	{pattern: "claude-sonnet-4-5*", canonical: "claude-sonnet-4.5"},
	{pattern: "claude-sonnet-4.5*", canonical: "claude-sonnet-4.5"},
	{pattern: "claude-4-5-sonnet*", canonical: "claude-sonnet-4.5"},
	{pattern: "claude-4.5-sonnet*", canonical: "claude-sonnet-4.5"},
	{pattern: "claude-haiku-4-5*", canonical: "claude-haiku-4.5"},
	{pattern: "claude-haiku-4.5*", canonical: "claude-haiku-4.5"},
	{pattern: "claude-4-5-haiku*", canonical: "claude-haiku-4.5"},
	{pattern: "claude-4.5-haiku*", canonical: "claude-haiku-4.5"},
	{pattern: "claude-opus-4-1*", canonical: "claude-opus-4.1"},
	{pattern: "claude-opus-4.1*", canonical: "claude-opus-4.1"},
	{pattern: "claude-opus-4*", canonical: "claude-opus-4"},
	{pattern: "claude-sonnet-4*", canonical: "claude-sonnet-4"},

	// Anthropic Claude 3.x
	{pattern: "claude-3-7-sonnet*", canonical: "claude-3.7-sonnet"},
	{pattern: "claude-3.7-sonnet*", canonical: "claude-3.7-sonnet"},
	{pattern: "claude-3-5-sonnet*", canonical: "claude-3.5-sonnet"},
	{pattern: "claude-3.5-sonnet*", canonical: "claude-3.5-sonnet"},
	{pattern: "claude-3-5-haiku*", canonical: "claude-3.5-haiku"},
	{pattern: "claude-3.5-haiku*", canonical: "claude-3.5-haiku"},

	// Google Gemini 4 aliases
	{pattern: "gemini-4.0-neon*", canonical: "gemini-4-neon"},
	{pattern: "gemini-4.0-carbon*", canonical: "gemini-4-carbon"},
	{pattern: "gemini-4.0-argon*", canonical: "gemini-4-argon"},
	{pattern: "gemini-4.0-hydrogen*", canonical: "gemini-4-hydrogen"},
}

// builtinModelPrices holds default USD prices per 1M tokens for popular coding models.
// More specific patterns must appear before broader wildcard patterns.
var builtinModelPrices = []ModelPrice{
	// Anthropic Claude
	{ModelPattern: "claude-opus-5.5", InputPerM: 4.00, OutputPerM: 20.00, CacheReadPerM: 0.20, CacheWritePerM: 5.00, CacheWrite1hPerM: 8.00, Builtin: true},
	{ModelPattern: "claude-opus-5", InputPerM: 5.00, OutputPerM: 25.00, CacheReadPerM: 0.50, CacheWritePerM: 6.25, CacheWrite1hPerM: 10.00, Builtin: true},
	{ModelPattern: "claude-sonnet-5.5", InputPerM: 2.00, OutputPerM: 10.00, CacheReadPerM: 0.10, CacheWritePerM: 2.50, CacheWrite1hPerM: 4.00, Builtin: true},
	{ModelPattern: "claude-sonnet-5", InputPerM: 2.00, OutputPerM: 10.00, CacheReadPerM: 0.20, CacheWritePerM: 2.50, CacheWrite1hPerM: 4.00, Builtin: true},
	{ModelPattern: "claude-haiku-5.5", InputPerM: 0.10, OutputPerM: 0.50, CacheReadPerM: 0.01, CacheWritePerM: 0.125, CacheWrite1hPerM: 0.20, Builtin: true},
	{ModelPattern: "claude-opus-4.7", InputPerM: 5.00, OutputPerM: 25.00, CacheReadPerM: 0.50, CacheWritePerM: 6.25, CacheWrite1hPerM: 10.00, Builtin: true},
	{ModelPattern: "claude-opus-4.6", InputPerM: 5.00, OutputPerM: 25.00, CacheReadPerM: 0.50, CacheWritePerM: 6.25, CacheWrite1hPerM: 10.00, Builtin: true},
	{ModelPattern: "claude-opus-4.5", InputPerM: 5.00, OutputPerM: 25.00, CacheReadPerM: 0.50, CacheWritePerM: 6.25, CacheWrite1hPerM: 10.00, Builtin: true},
	{ModelPattern: "claude-opus-4.1", InputPerM: 15.00, OutputPerM: 75.00, CacheReadPerM: 1.50, CacheWritePerM: 18.75, CacheWrite1hPerM: 30.00, Builtin: true},
	{ModelPattern: "claude-opus-4", InputPerM: 15.00, OutputPerM: 75.00, CacheReadPerM: 1.50, CacheWritePerM: 18.75, CacheWrite1hPerM: 30.00, Builtin: true},
	{ModelPattern: "claude-sonnet-4.7", InputPerM: 3.00, OutputPerM: 15.00, CacheReadPerM: 0.30, CacheWritePerM: 3.75, CacheWrite1hPerM: 6.00, Builtin: true},
	{ModelPattern: "claude-sonnet-4.6", InputPerM: 3.00, OutputPerM: 15.00, CacheReadPerM: 0.30, CacheWritePerM: 3.75, CacheWrite1hPerM: 6.00, Builtin: true},
	{ModelPattern: "claude-sonnet-4.5", InputPerM: 3.00, OutputPerM: 15.00, CacheReadPerM: 0.30, CacheWritePerM: 3.75, CacheWrite1hPerM: 6.00, Builtin: true},
	{ModelPattern: "claude-sonnet-4", InputPerM: 3.00, OutputPerM: 15.00, CacheReadPerM: 0.30, CacheWritePerM: 3.75, CacheWrite1hPerM: 6.00, Builtin: true},
	{ModelPattern: "claude-3.7-sonnet", InputPerM: 3.00, OutputPerM: 15.00, CacheReadPerM: 0.30, CacheWritePerM: 3.75, CacheWrite1hPerM: 6.00, Builtin: true},
	{ModelPattern: "claude-3.5-sonnet", InputPerM: 3.00, OutputPerM: 15.00, CacheReadPerM: 0.30, CacheWritePerM: 3.75, CacheWrite1hPerM: 6.00, Builtin: true},
	{ModelPattern: "claude-haiku-4.5", InputPerM: 1.00, OutputPerM: 5.00, CacheReadPerM: 0.10, CacheWritePerM: 1.25, CacheWrite1hPerM: 2.00, Builtin: true},
	{ModelPattern: "claude-3.5-haiku", InputPerM: 0.80, OutputPerM: 4.00, CacheReadPerM: 0.08, CacheWritePerM: 1.00, CacheWrite1hPerM: 1.60, Builtin: true},

	// OpenAI GPT / Codex / o-series
	{ModelPattern: "gpt-5.6*", InputPerM: 4.00, OutputPerM: 20.00, CacheReadPerM: 0.40, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5.5-mini*", InputPerM: 0.90, OutputPerM: 5.50, CacheReadPerM: 0.09, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5.5*", InputPerM: 5.00, OutputPerM: 30.00, CacheReadPerM: 0.50, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5.4-pro*", InputPerM: 30.00, OutputPerM: 180.00, CacheReadPerM: 3.00, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5.4-mini*", InputPerM: 0.75, OutputPerM: 4.50, CacheReadPerM: 0.075, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5.4-nano*", InputPerM: 0.20, OutputPerM: 1.25, CacheReadPerM: 0.02, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5.4*", InputPerM: 2.50, OutputPerM: 15.00, CacheReadPerM: 0.25, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5.3-codex*", InputPerM: 1.75, OutputPerM: 14.00, CacheReadPerM: 0.175, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5.3*", InputPerM: 1.75, OutputPerM: 14.00, CacheReadPerM: 0.175, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5.2-codex*", InputPerM: 1.75, OutputPerM: 14.00, CacheReadPerM: 0.175, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5.2*", InputPerM: 1.75, OutputPerM: 14.00, CacheReadPerM: 0.175, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5.1-codex*", InputPerM: 1.25, OutputPerM: 10.00, CacheReadPerM: 0.125, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5-codex*", InputPerM: 1.25, OutputPerM: 10.00, CacheReadPerM: 0.125, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5-mini*", InputPerM: 0.25, OutputPerM: 2.00, CacheReadPerM: 0.025, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5-nano*", InputPerM: 0.05, OutputPerM: 0.40, CacheReadPerM: 0.005, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-5*", InputPerM: 1.25, OutputPerM: 10.00, CacheReadPerM: 0.125, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-4.1-nano*", InputPerM: 0.10, OutputPerM: 0.40, CacheReadPerM: 0.025, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-4.1-mini*", InputPerM: 0.40, OutputPerM: 1.60, CacheReadPerM: 0.10, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-4.1*", InputPerM: 2.00, OutputPerM: 8.00, CacheReadPerM: 0.50, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-4o-mini*", InputPerM: 0.15, OutputPerM: 0.60, CacheReadPerM: 0.075, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gpt-4o*", InputPerM: 2.50, OutputPerM: 10.00, CacheReadPerM: 1.25, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "o3-mini*", InputPerM: 1.10, OutputPerM: 4.40, CacheReadPerM: 0.55, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "o3*", InputPerM: 2.00, OutputPerM: 8.00, CacheReadPerM: 0.50, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "o4-mini*", InputPerM: 1.10, OutputPerM: 4.40, CacheReadPerM: 0.275, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},

	// Google Gemini
	{ModelPattern: "gemini-4-neon*", InputPerM: 3.00, OutputPerM: 15.00, CacheReadPerM: 0.15, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gemini-4-carbon*", InputPerM: 2.00, OutputPerM: 10.00, CacheReadPerM: 0.10, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gemini-4-argon*", InputPerM: 2.00, OutputPerM: 10.00, CacheReadPerM: 0.10, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gemini-4-hydrogen*", InputPerM: 1.50, OutputPerM: 7.50, CacheReadPerM: 0.075, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gemini-3.8-flash*", InputPerM: 0.75, OutputPerM: 3.75, CacheReadPerM: 0.075, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gemini-3.7-flash*", InputPerM: 0.75, OutputPerM: 3.75, CacheReadPerM: 0.075, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gemini-3.6-flash*", InputPerM: 0.75, OutputPerM: 3.75, CacheReadPerM: 0.075, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gemini-3.5-flash-lite*", InputPerM: 0.30, OutputPerM: 2.50, CacheReadPerM: 0.03, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gemini-3.5-flash*", InputPerM: 1.50, OutputPerM: 9.00, CacheReadPerM: 0.15, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gemini-3.1-pro*", InputPerM: 2.00, OutputPerM: 12.00, CacheReadPerM: 0.20, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gemini-3.1-flash-lite*", InputPerM: 0.25, OutputPerM: 1.50, CacheReadPerM: 0.025, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gemini-3.1-flash*", InputPerM: 0.50, OutputPerM: 3.00, CacheReadPerM: 0.05, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gemini-3-pro*", InputPerM: 2.00, OutputPerM: 12.00, CacheReadPerM: 0.20, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gemini-3-flash*", InputPerM: 0.50, OutputPerM: 3.00, CacheReadPerM: 0.05, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gemini-2.5-pro*", InputPerM: 1.25, OutputPerM: 10.00, CacheReadPerM: 0.125, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gemini-2.5-flash-lite*", InputPerM: 0.10, OutputPerM: 0.40, CacheReadPerM: 0.01, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "gemini-2.5-flash*", InputPerM: 0.30, OutputPerM: 2.50, CacheReadPerM: 0.03, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},

	// DeepSeek
	{ModelPattern: "deepseek-v4-pro*", InputPerM: 1.32, OutputPerM: 3.96, CacheReadPerM: 0.044, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "deepseek-v4.1-flash*", InputPerM: 0.30, OutputPerM: 1.20, CacheReadPerM: 0.006, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "deepseek-v4-flash*", InputPerM: 0.30, OutputPerM: 1.20, CacheReadPerM: 0.006, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "deepseek-flash*", InputPerM: 0.30, OutputPerM: 1.20, CacheReadPerM: 0.006, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "deepseek-v4*", InputPerM: 1.32, OutputPerM: 3.96, CacheReadPerM: 0.044, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "deepseek-v3.2*", InputPerM: 0.26, OutputPerM: 0.38, CacheReadPerM: 0.13, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "deepseek-reasoner*", InputPerM: 0.55, OutputPerM: 2.19, CacheReadPerM: 0.14, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "deepseek-r1*", InputPerM: 0.55, OutputPerM: 2.19, CacheReadPerM: 0.14, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "deepseek-chat*", InputPerM: 0.27, OutputPerM: 1.10, CacheReadPerM: 0.07, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "deepseek-v3*", InputPerM: 0.27, OutputPerM: 1.10, CacheReadPerM: 0.07, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},

	// Zhipu GLM
	{ModelPattern: "glm-5.3-flashx*", InputPerM: 0.37, OutputPerM: 1.25, CacheReadPerM: 0.075, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "glm-5.3-flash*", InputPerM: 0.15, OutputPerM: 0.50, CacheReadPerM: 0.03, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "glm-5.3*", InputPerM: 1.40, OutputPerM: 4.40, CacheReadPerM: 0.26, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "glm-5.2*", InputPerM: 1.40, OutputPerM: 4.40, CacheReadPerM: 0.26, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "glm-5*", InputPerM: 1.00, OutputPerM: 3.20, CacheReadPerM: 0.20, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "glm-4.7-flashx*", InputPerM: 0.07, OutputPerM: 0.40, CacheReadPerM: 0.01, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "glm-4.7-flash*", InputPerM: 0.00, OutputPerM: 0.00, CacheReadPerM: 0.00, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "glm-4.7*", InputPerM: 0.60, OutputPerM: 2.20, CacheReadPerM: 0.11, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "glm-4.6*", InputPerM: 0.60, OutputPerM: 2.20, CacheReadPerM: 0.11, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "glm-4.5-air*", InputPerM: 0.20, OutputPerM: 1.10, CacheReadPerM: 0.03, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "glm-4.5*", InputPerM: 0.60, OutputPerM: 2.20, CacheReadPerM: 0.11, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},

	// Moonshot Kimi
	{ModelPattern: "kimi-k3.1-pro-highspeed*", InputPerM: 4.00, OutputPerM: 20.00, CacheReadPerM: 0.20, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "kimi-k3.1*", InputPerM: 2.00, OutputPerM: 10.00, CacheReadPerM: 0.20, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "kimi-k3*", InputPerM: 3.00, OutputPerM: 15.00, CacheReadPerM: 0.30, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "kimi-k2.7*", InputPerM: 0.95, OutputPerM: 4.00, CacheReadPerM: 0.16, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "kimi-k2.6*", InputPerM: 0.95, OutputPerM: 4.00, CacheReadPerM: 0.16, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "kimi-k2.5*", InputPerM: 0.60, OutputPerM: 3.00, CacheReadPerM: 0.10, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "kimi-k2*", InputPerM: 0.60, OutputPerM: 2.50, CacheReadPerM: 0.15, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "kimi-for-coding*", InputPerM: 0.60, OutputPerM: 2.50, CacheReadPerM: 0.15, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},

	// Alibaba Qwen
	{ModelPattern: "qwen3.8-max*", InputPerM: 2.00, OutputPerM: 6.00, CacheReadPerM: 0.20, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "qwen3.8-flash*", InputPerM: 0.15, OutputPerM: 0.47, CacheReadPerM: 0.015, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "qwen3.7-max*", InputPerM: 2.50, OutputPerM: 7.50, CacheReadPerM: 0.25, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "qwen3.7-plus*", InputPerM: 0.40, OutputPerM: 1.60, CacheReadPerM: 0.04, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "qwen3-coder*", InputPerM: 0.30, OutputPerM: 1.50, CacheReadPerM: 0.03, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "qwen3-max*", InputPerM: 1.20, OutputPerM: 6.00, CacheReadPerM: 0.12, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "qwen3-plus*", InputPerM: 0.40, OutputPerM: 1.60, CacheReadPerM: 0.04, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "qwen3.5*", InputPerM: 0.40, OutputPerM: 1.60, CacheReadPerM: 0.04, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},

	// MiniMax
	{ModelPattern: "minimax-m3.1-flash*", InputPerM: 0.15, OutputPerM: 0.60, CacheReadPerM: 0.015, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "minimax-m3*", InputPerM: 0.30, OutputPerM: 1.20, CacheReadPerM: 0.06, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "minimax-m2.7*", InputPerM: 0.30, OutputPerM: 1.20, CacheReadPerM: 0.06, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "minimax-m2.5*", InputPerM: 0.30, OutputPerM: 1.20, CacheReadPerM: 0.06, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "minimax-m2*", InputPerM: 0.30, OutputPerM: 1.20, CacheReadPerM: 0.03, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},

	// xAI Grok
	{ModelPattern: "grok-4.7*", InputPerM: 2.00, OutputPerM: 6.00, CacheReadPerM: 0.50, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "grok-4.6*", InputPerM: 2.00, OutputPerM: 6.00, CacheReadPerM: 0.50, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "grok-4.3*", InputPerM: 1.25, OutputPerM: 2.50, CacheReadPerM: 0.20, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "grok-code-fast*", InputPerM: 0.20, OutputPerM: 1.50, CacheReadPerM: 0.02, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "grok-build*", InputPerM: 1.00, OutputPerM: 2.00, CacheReadPerM: 0.20, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
	{ModelPattern: "grok-4*", InputPerM: 3.00, OutputPerM: 15.00, CacheReadPerM: 0.75, CacheWritePerM: 0, CacheWrite1hPerM: 0, Builtin: true},
}

func DefaultModelPrices() []ModelPrice {
	out := make([]ModelPrice, len(builtinModelPrices))
	copy(out, builtinModelPrices)
	return out
}

// MatchPattern performs case-insensitive glob matching supporting '*' wildcards.
func MatchPattern(pattern, target string) bool {
	p := strings.ToLower(strings.TrimSpace(pattern))
	s := strings.ToLower(strings.TrimSpace(target))
	if p == "" {
		return false
	}
	if p == "*" || p == s {
		return true
	}
	parts := strings.Split(p, "*")
	if len(parts) == 1 {
		return p == s
	}
	if !strings.HasPrefix(s, parts[0]) {
		return false
	}
	s = s[len(parts[0]):]
	last := parts[len(parts)-1]
	if !strings.HasSuffix(s, last) {
		return false
	}
	s = s[:len(s)-len(last)]
	for _, mid := range parts[1 : len(parts)-1] {
		if mid == "" {
			continue
		}
		idx := strings.Index(s, mid)
		if idx < 0 {
			return false
		}
		s = s[idx+len(mid):]
	}
	return true
}

// NormalizeModel resolves a raw model name via user aliases first, then built-in normalization rules.
func NormalizeModel(raw string, userAliases []ModelAlias) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "unknown"
	}

	// 1. User custom aliases take top priority (already ordered by priority ASC, id ASC).
	for _, a := range userAliases {
		if MatchPattern(a.MatchPattern, trimmed) {
			if canon := strings.TrimSpace(a.CanonicalModel); canon != "" {
				return canon
			}
		}
	}

	// 2. Strip common provider prefixes (recursively for multi-layer routes like openrouter/anthropic/...)
	// and trailing routing/date/version tags.
	cleaned := strings.ToLower(trimmed)
	for {
		stripped := false
		for _, pfx := range providerPrefixes {
			if strings.HasPrefix(cleaned, pfx) {
				cleaned = strings.TrimPrefix(cleaned, pfx)
				stripped = true
				break
			}
		}
		if !stripped {
			break
		}
	}
	cleaned = reTagSuffix.ReplaceAllString(cleaned, "")
	cleaned = reDateSuffix.ReplaceAllString(cleaned, "")

	// Re-check user aliases against stripped name as well.
	for _, a := range userAliases {
		if MatchPattern(a.MatchPattern, cleaned) {
			if canon := strings.TrimSpace(a.CanonicalModel); canon != "" {
				return canon
			}
		}
	}

	// 3. Built-in family canonicalization.
	for _, rule := range builtinAliasRules {
		if MatchPattern(rule.pattern, cleaned) {
			return rule.canonical
		}
	}
	return cleaned
}

// ResolvePrice finds the best matching price entry: user custom prices first, then built-in table.
func ResolvePrice(rawModel, canonicalModel string, userPrices []ModelPrice) (ModelPrice, bool) {
	// Check exact user overrides first, then wildcard user overrides (longer pattern first).
	ordered := make([]ModelPrice, len(userPrices))
	copy(ordered, userPrices)
	sort.SliceStable(ordered, func(i, j int) bool {
		wi := strings.Contains(ordered[i].ModelPattern, "*")
		wj := strings.Contains(ordered[j].ModelPattern, "*")
		if wi != wj {
			return !wi
		}
		return len(ordered[i].ModelPattern) > len(ordered[j].ModelPattern)
	})
	for _, p := range ordered {
		if MatchPattern(p.ModelPattern, canonicalModel) || MatchPattern(p.ModelPattern, rawModel) {
			return p, true
		}
	}

	// Build candidate list for built-in table matching, including a slash-stripped fallback
	// so arbitrary custom relay prefixes (e.g. my-proxy/claude-opus-5-5) still resolve a price.
	candidates := []string{canonicalModel, rawModel}
	if idx := strings.LastIndex(canonicalModel, "/"); idx >= 0 && idx < len(canonicalModel)-1 {
		base := NormalizeModel(canonicalModel[idx+1:], nil)
		if base != "" {
			candidates = append(candidates, base)
		}
	}
	for _, p := range builtinModelPrices {
		for _, c := range candidates {
			if MatchPattern(p.ModelPattern, c) {
				return p, true
			}
		}
	}
	return ModelPrice{}, false
}

// ComputeCost calculates equivalent USD cost and cache savings for one slice.
func ComputeCost(row HourlySessionRecord, canonicalModel string, userPrices []ModelPrice) (costUSD float64, cacheSavingsUSD float64) {
	price, ok := ResolvePrice(row.Model, canonicalModel, userPrices)
	if !ok {
		return row.ReportedCostUSD, 0
	}

	const perMillion = 1_000_000.0
	outputBillable := row.OutputTokens + row.ReasoningTokens
	cacheWrite1hRate := price.CacheWrite1hPerM
	if cacheWrite1hRate <= 0 {
		cacheWrite1hRate = price.CacheWritePerM
	}

	costUSD = (float64(row.InputTokens)*price.InputPerM +
		float64(outputBillable)*price.OutputPerM +
		float64(row.CacheReadTokens)*price.CacheReadPerM +
		float64(row.CacheWriteTokens)*price.CacheWritePerM +
		float64(row.CacheWrite1hTokens)*cacheWrite1hRate) / perMillion

	if row.CacheReadTokens > 0 && price.InputPerM > price.CacheReadPerM {
		cacheSavingsUSD = float64(row.CacheReadTokens) * (price.InputPerM - price.CacheReadPerM) / perMillion
	}
	return costUSD, cacheSavingsUSD
}
