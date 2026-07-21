package syncapi

import (
	"math"
	"testing"
)

func TestThemeDefinitionBounds(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*CustomTheme)
	}{
		{"radius", func(theme *CustomTheme) { theme.Definition.Shape.Radius = 24.1 }},
		{"border width", func(theme *CustomTheme) { theme.Definition.Shape.BorderWidth = -0.1 }},
		{"blur", func(theme *CustomTheme) { theme.Definition.Effects.Blur = 31 }},
		{"opacity", func(theme *CustomTheme) { theme.Definition.Effects.Opacity = 0.64 }},
		{"shadow", func(theme *CustomTheme) { theme.Definition.Effects.Shadow = math.NaN() }},
		{"font family", func(theme *CustomTheme) { theme.Definition.Typography.Family = "serif" }},
		{"font scale", func(theme *CustomTheme) { theme.Definition.Typography.Scale = 1.21 }},
		{"font weight", func(theme *CustomTheme) { theme.Definition.Typography.Weight = 399 }},
		{"density", func(theme *CustomTheme) { theme.Definition.Density = 0.79 }},
		{"motion", func(theme *CustomTheme) { theme.Definition.Motion = 1.51 }},
		{"icon size", func(theme *CustomTheme) { theme.Definition.IconSize = 73 }},
		{"trimmed name", func(theme *CustomTheme) { theme.Name = " Theme" }},
		{"control in name", func(theme *CustomTheme) { theme.Name = "Theme\n" }},
		{"built-in ID", func(theme *CustomTheme) { theme.ID = defaultThemeID }},
		{"low contrast", func(theme *CustomTheme) { theme.Definition.Colors.Text = theme.Definition.Colors.Window }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			theme := CustomTheme{ID: "custom", Name: "Custom", Definition: testThemeDefinition(), Revision: 1}
			test.mutate(&theme)
			if err := validateTheme(theme); err == nil {
				t.Fatal("invalid theme was accepted")
			}
		})
	}
}

func TestAppearanceValidationRequiresUniqueExistingSelectionAndLimit(t *testing.T) {
	theme := CustomTheme{ID: "custom", Name: "Custom", Definition: testThemeDefinition(), Revision: 1}
	if err := validateAppearance(Appearance{SelectedThemeID: theme.ID, SelectionRevision: 1, CustomThemes: []CustomTheme{theme}}); err != nil {
		t.Fatalf("valid appearance: %v", err)
	}
	if err := validateAppearance(Appearance{SelectedThemeID: "missing", CustomThemes: []CustomTheme{theme}}); err == nil {
		t.Fatal("missing selected theme was accepted")
	}
	if err := validateAppearance(Appearance{SelectedThemeID: theme.ID, CustomThemes: []CustomTheme{theme, theme}}); err == nil {
		t.Fatal("duplicate theme ID was accepted")
	}
	themes := make([]CustomTheme, 25)
	for i := range themes {
		themes[i] = theme
	}
	if err := validateAppearance(Appearance{SelectedThemeID: defaultThemeID, CustomThemes: themes}); err == nil {
		t.Fatal("more than 24 custom themes were accepted")
	}
}
