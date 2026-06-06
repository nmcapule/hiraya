package static

import "embed"

// FS contains the built React application.
//
//go:embed dist
var FS embed.FS
