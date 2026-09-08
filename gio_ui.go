//go:build gio

package main

import (
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"strings"

	"gioui.org/app"
	"gioui.org/layout"
	"gioui.org/op"
	"gioui.org/op/clip"
	"gioui.org/op/paint"
	"gioui.org/unit"
	"gioui.org/widget"
	"gioui.org/widget/material"
	"gioui.org/x/component"
)

const gioPageSize = 100

var (
	gioBG       = color.NRGBA{R: 13, G: 15, B: 18, A: 255}
	gioPanel    = color.NRGBA{R: 20, G: 23, B: 28, A: 255}
	gioPanelAlt = color.NRGBA{R: 25, G: 29, B: 35, A: 255}
	gioBorder   = color.NRGBA{R: 45, G: 51, B: 61, A: 255}
	gioText     = color.NRGBA{R: 226, G: 232, B: 240, A: 255}
	gioMuted    = color.NRGBA{R: 139, G: 148, B: 162, A: 255}
	gioAccent   = color.NRGBA{R: 97, G: 126, B: 255, A: 255}
	gioDanger   = color.NRGBA{R: 255, G: 115, B: 115, A: 255}
)

type gioFrontend struct {
	backend *App
	window  *app.Window
	theme   *material.Theme
	ops     op.Ops
	updates chan func()

	demoButton    widget.Clickable
	refreshButton widget.Clickable
	applyFilter   widget.Clickable
	clearFilter   widget.Clickable
	prevButton    widget.Clickable
	nextButton    widget.Clickable
	filterEditor  widget.Editor
	tableList     widget.List
	tableButtons  []widget.Clickable
	headerButtons []widget.Clickable
	grid          component.GridState

	session ConnectionStatus
	tables  []TableSummary
	active  int
	data    TableData
	page    int
	sortCol string
	sortDir string
	loading bool
	status  string
	errText string
}

func newGioFrontend(backend *App, window *app.Window) *gioFrontend {
	th := material.NewTheme()
	th.Palette.Bg = gioBG
	th.Palette.Fg = gioText
	th.Palette.ContrastBg = gioAccent
	th.Palette.ContrastFg = color.NRGBA{R: 255, G: 255, B: 255, A: 255}
	th.TextSize = unit.Sp(14)

	ui := &gioFrontend{
		backend: backend,
		window: window,
		theme: th,
		updates: make(chan func(), 32),
		active: -1,
	}
	ui.filterEditor.SingleLine = true
	ui.tableList.Axis = layout.Vertical
	ui.grid.LockedRows = 1
	return ui
}

func (ui *gioFrontend) run() error {
	for {
		switch event := ui.window.Event().(type) {
		case app.DestroyEvent:
			return event.Err
		case app.FrameEvent:
			ui.drainUpdates()
			gtx := app.NewContext(&ui.ops, event)
			ui.layout(gtx)
			event.Frame(gtx.Ops)
		}
	}
}

func (ui *gioFrontend) drainUpdates() {
	for {
		select {
		case update := <-ui.updates:
			update()
		default:
			return
		}
	}
}

func (ui *gioFrontend) async(work func() (func(), error)) {
	if ui.loading {
		return
	}
	ui.loading = true
	ui.errText = ""
	ui.window.Invalidate()
	go func() {
		apply, err := work()
		ui.updates <- func() {
			ui.loading = false
			if err != nil {
				ui.errText = err.Error()
				return
			}
			if apply != nil {
				apply()
			}
		}
		ui.window.Invalidate()
	}()
}

func (ui *gioFrontend) layout(gtx layout.Context) layout.Dimensions {
	paint.Fill(gtx.Ops, gioBG)

	if ui.demoButton.Clicked(gtx) {
		ui.openDemo()
	}
	if ui.refreshButton.Clicked(gtx) && ui.session.Connected {
		ui.reloadTables()
	}
	if ui.applyFilter.Clicked(gtx) && ui.active >= 0 {
		ui.page = 0
		ui.loadActiveTable()
	}
	if ui.clearFilter.Clicked(gtx) && ui.active >= 0 {
		ui.filterEditor.SetText("")
		ui.page = 0
		ui.loadActiveTable()
	}
	if ui.prevButton.Clicked(gtx) && ui.page > 0 {
		ui.page--
		ui.loadActiveTable()
	}
	if ui.nextButton.Clicked(gtx) && int64((ui.page+1)*gioPageSize) < ui.data.Total {
		ui.page++
		ui.loadActiveTable()
	}

	if !ui.session.Connected {
		return ui.layoutWelcome(gtx)
	}
	return ui.layoutWorkspace(gtx)
}

func (ui *gioFrontend) layoutWelcome(gtx layout.Context) layout.Dimensions {
	return layout.Center.Layout(gtx, func(gtx layout.Context) layout.Dimensions {
		return layout.Inset{Left: 32, Right: 32, Top: 32, Bottom: 32}.Layout(gtx, func(gtx layout.Context) layout.Dimensions {
			return layout.Flex{Axis: layout.Vertical, Alignment: layout.Middle}.Layout(gtx,
				layout.Rigid(func(gtx layout.Context) layout.Dimensions {
					label := material.Label(ui.theme, unit.Sp(12), "DATABASE WORKSPACE · GIO")
					label.Color = gioAccent
					return label.Layout(gtx)
				}),
				layout.Rigid(spacerY(14)),
				layout.Rigid(func(gtx layout.Context) layout.Dimensions {
					label := material.H3(ui.theme, "Your data, without the WebView.")
					label.Color = gioText
					return label.Layout(gtx)
				}),
				layout.Rigid(spacerY(12)),
				layout.Rigid(func(gtx layout.Context) layout.Dimensions {
					label := material.Body1(ui.theme, "Native Gio rendering backed by the existing Go database/session layer. This first slice includes table navigation, a virtualized 2D grid, sorting, filtering and pagination.")
					label.Color = gioMuted
					return label.Layout(gtx)
				}),
				layout.Rigid(spacerY(24)),
				layout.Rigid(func(gtx layout.Context) layout.Dimensions {
					button := material.Button(ui.theme, &ui.demoButton, "Explore demo database")
					button.Background = gioAccent
					button.CornerRadius = unit.Dp(8)
					return button.Layout(gtx)
				}),
				layout.Rigid(spacerY(14)),
				layout.Rigid(func(gtx layout.Context) layout.Dimensions {
					text := "SQLite picker and PostgreSQL connection form are the next migration slice."
					if ui.loading {
						text = "Opening demo database…"
					}
					if ui.errText != "" {
						text = ui.errText
					}
					label := material.Caption(ui.theme, text)
					label.Color = gioMuted
					if ui.errText != "" {
						label.Color = gioDanger
					}
					return label.Layout(gtx)
				}),
			)
		})
	})
}

func (ui *gioFrontend) layoutWorkspace(gtx layout.Context) layout.Dimensions {
	return layout.Flex{Axis: layout.Vertical}.Layout(gtx,
		layout.Rigid(ui.layoutTopBar),
		layout.Flexed(1, func(gtx layout.Context) layout.Dimensions {
			return layout.Flex{Axis: layout.Horizontal}.Layout(gtx,
				layout.Rigid(func(gtx layout.Context) layout.Dimensions {
					return fixedWidth(gtx, unit.Dp(260), ui.layoutSidebar)
				}),
				layout.Flexed(1, ui.layoutTableArea),
			)
		}),
		layout.Rigid(ui.layoutStatus),
	)
}

func (ui *gioFrontend) layoutTopBar(gtx layout.Context) layout.Dimensions {
	return fill(gtx, gioPanel, func(gtx layout.Context) layout.Dimensions {
		return layout.Inset{Left: 16, Right: 16, Top: 10, Bottom: 10}.Layout(gtx, func(gtx layout.Context) layout.Dimensions {
			return layout.Flex{Axis: layout.Horizontal, Alignment: layout.Middle}.Layout(gtx,
				layout.Rigid(func(gtx layout.Context) layout.Dimensions {
					label := material.Subtitle1(ui.theme, fmt.Sprintf("QueryNest · %s", ui.session.Database))
					label.Color = gioText
					return label.Layout(gtx)
				}),
				layout.Flexed(1, func(gtx layout.Context) layout.Dimensions { return layout.Dimensions{Size: gtx.Constraints.Min} }),
				layout.Rigid(func(gtx layout.Context) layout.Dimensions {
					button := material.Button(ui.theme, &ui.refreshButton, "Refresh")
					button.Background = gioPanelAlt
					button.Color = gioText
					return button.Layout(gtx)
				}),
			)
		})
	})
}

func (ui *gioFrontend) layoutSidebar(gtx layout.Context) layout.Dimensions {
	return fill(gtx, gioPanel, func(gtx layout.Context) layout.Dimensions {
		return layout.Flex{Axis: layout.Vertical}.Layout(gtx,
			layout.Rigid(func(gtx layout.Context) layout.Dimensions {
				return layout.Inset{Left: 14, Top: 14, Bottom: 8}.Layout(gtx, func(gtx layout.Context) layout.Dimensions {
					label := material.Label(ui.theme, unit.Sp(11), "TABLES & VIEWS")
					label.Color = gioMuted
					return label.Layout(gtx)
				})
			}),
			layout.Flexed(1, func(gtx layout.Context) layout.Dimensions {
				return material.List(ui.theme, &ui.tableList).Layout(gtx, len(ui.tables), func(gtx layout.Context, index int) layout.Dimensions {
					for ui.tableButtons[index].Clicked(gtx) {
						if index != ui.active && !ui.loading {
							ui.active = index
							ui.page = 0
							ui.sortCol, ui.sortDir = "", ""
							ui.loadActiveTable()
						}
					}
					item := ui.tables[index]
					bg := gioPanel
					if index == ui.active {
						bg = gioPanelAlt
					}
					return material.Clickable(gtx, &ui.tableButtons[index], func(gtx layout.Context) layout.Dimensions {
						return fill(gtx, bg, func(gtx layout.Context) layout.Dimensions {
							return layout.Inset{Left: 14, Right: 12, Top: 10, Bottom: 10}.Layout(gtx, func(gtx layout.Context) layout.Dimensions {
								label := material.Body2(ui.theme, fmt.Sprintf("%s   %d", item.Name, item.Rows))
								label.Color = gioText
								label.MaxLines = 1
								return label.Layout(gtx)
							})
						})
					})
				})
			}),
		)
	})
}

func (ui *gioFrontend) layoutTableArea(gtx layout.Context) layout.Dimensions {
	if ui.active < 0 || ui.active >= len(ui.tables) {
		return layout.Center.Layout(gtx, func(gtx layout.Context) layout.Dimensions {
			label := material.Body1(ui.theme, "Select a table")
			label.Color = gioMuted
			return label.Layout(gtx)
		})
	}
	return layout.Flex{Axis: layout.Vertical}.Layout(gtx,
		layout.Rigid(ui.layoutToolbar),
		layout.Flexed(1, func(gtx layout.Context) layout.Dimensions {
			if ui.loading && len(ui.data.Columns) == 0 {
				return layout.Center.Layout(gtx, material.Loader(ui.theme).Layout)
			}
			if len(ui.data.Columns) == 0 {
				return layout.Center.Layout(gtx, func(gtx layout.Context) layout.Dimensions {
					label := material.Body1(ui.theme, "No result columns")
					label.Color = gioMuted
					return label.Layout(gtx)
				})
			}
			return ui.layoutGrid(gtx)
		}),
		layout.Rigid(ui.layoutPager),
	)
}

func (ui *gioFrontend) layoutToolbar(gtx layout.Context) layout.Dimensions {
	item := ui.tables[ui.active]
	return fill(gtx, gioPanelAlt, func(gtx layout.Context) layout.Dimensions {
		return layout.Inset{Left: 14, Right: 14, Top: 10, Bottom: 10}.Layout(gtx, func(gtx layout.Context) layout.Dimensions {
			return layout.Flex{Axis: layout.Horizontal, Alignment: layout.Middle}.Layout(gtx,
				layout.Rigid(func(gtx layout.Context) layout.Dimensions {
					label := material.Subtitle2(ui.theme, item.Schema+"."+item.Name)
					label.Color = gioText
					return label.Layout(gtx)
				}),
				layout.Flexed(1, func(gtx layout.Context) layout.Dimensions { return layout.Dimensions{Size: gtx.Constraints.Min} }),
				layout.Rigid(func(gtx layout.Context) layout.Dimensions {
					return fixedWidth(gtx, unit.Dp(260), func(gtx layout.Context) layout.Dimensions {
						editor := material.Editor(ui.theme, &ui.filterEditor, "Filter")
						editor.TextSize = unit.Sp(13)
						return editor.Layout(gtx)
					})
				}),
				layout.Rigid(spacerX(8)),
				layout.Rigid(func(gtx layout.Context) layout.Dimensions {
					button := material.Button(ui.theme, &ui.applyFilter, "Apply")
					button.Background = gioAccent
					return button.Layout(gtx)
				}),
				layout.Rigid(spacerX(6)),
				layout.Rigid(func(gtx layout.Context) layout.Dimensions {
					button := material.Button(ui.theme, &ui.clearFilter, "Clear")
					button.Background = gioPanel
					button.Color = gioText
					return button.Layout(gtx)
				}),
			)
		})
	})
}

func (ui *gioFrontend) layoutGrid(gtx layout.Context) layout.Dimensions {
	ui.ensureHeaderButtons()
	grid := component.Grid(ui.theme, &ui.grid)
	grid.AnchorStrategy = material.Overlay
	rows, cols := len(ui.data.Rows)+1, len(ui.data.Columns)

	dimensioner := func(axis layout.Axis, index, constraint int) int {
		if axis == layout.Vertical {
			if index == 0 {
				return gtx.Dp(unit.Dp(40))
			}
			return gtx.Dp(unit.Dp(36))
		}
		return gtx.Dp(unit.Dp(180))
	}

	return grid.Layout(gtx, rows, cols, dimensioner, func(gtx layout.Context, row, col int) layout.Dimensions {
		if row == 0 {
			for ui.headerButtons[col].Clicked(gtx) {
				ui.toggleSort(ui.data.Columns[col])
			}
			return material.Clickable(gtx, &ui.headerButtons[col], func(gtx layout.Context) layout.Dimensions {
				name := ui.data.Columns[col]
				if ui.sortCol == name {
					if ui.sortDir == "asc" {
						name += " ↑"
					} else {
						name += " ↓"
					}
				}
				return ui.gridCell(gtx, name, true, false)
			})
		}
		value := ""
		if col < len(ui.data.Rows[row-1]) {
			value = gioCellText(ui.data.Rows[row-1][col])
		}
		return ui.gridCell(gtx, value, false, row%2 == 0)
	})
}

func (ui *gioFrontend) gridCell(gtx layout.Context, text string, header, alternate bool) layout.Dimensions {
	size := gtx.Constraints.Min
	bg := gioBG
	if alternate {
		bg = color.NRGBA{R: 16, G: 19, B: 23, A: 255}
	}
	if header {
		bg = gioPanelAlt
	}
	paint.FillShape(gtx.Ops, bg, clip.Rect{Max: size}.Op())
	paint.FillShape(gtx.Ops, gioBorder, clip.Rect{Min: image.Pt(size.X-1, 0), Max: size}.Op())
	paint.FillShape(gtx.Ops, gioBorder, clip.Rect{Min: image.Pt(0, size.Y-1), Max: size}.Op())

	return layout.Inset{Left: 10, Right: 10, Top: 8, Bottom: 8}.Layout(gtx, func(gtx layout.Context) layout.Dimensions {
		label := material.Label(ui.theme, unit.Sp(12), text)
		label.Color = gioText
		label.MaxLines = 1
		return label.Layout(gtx)
	})
}

func (ui *gioFrontend) layoutPager(gtx layout.Context) layout.Dimensions {
	return fill(gtx, gioPanelAlt, func(gtx layout.Context) layout.Dimensions {
		return layout.Inset{Left: 14, Right: 14, Top: 8, Bottom: 8}.Layout(gtx, func(gtx layout.Context) layout.Dimensions {
			start := int64(ui.page*gioPageSize + 1)
			end := int64((ui.page + 1) * gioPageSize)
			if end > ui.data.Total {
				end = ui.data.Total
			}
			if ui.data.Total == 0 {
				start = 0
			}
			return layout.Flex{Axis: layout.Horizontal, Alignment: layout.Middle}.Layout(gtx,
				layout.Rigid(func(gtx layout.Context) layout.Dimensions {
					label := material.Caption(ui.theme, fmt.Sprintf("Rows %d–%d of %d · %d ms", start, end, ui.data.Total, ui.data.DurationMs))
					label.Color = gioMuted
					return label.Layout(gtx)
				}),
				layout.Flexed(1, func(gtx layout.Context) layout.Dimensions { return layout.Dimensions{Size: gtx.Constraints.Min} }),
				layout.Rigid(func(gtx layout.Context) layout.Dimensions {
					button := material.Button(ui.theme, &ui.prevButton, "Previous")
					button.Background = gioPanel
					button.Color = gioText
					return button.Layout(gtx)
				}),
				layout.Rigid(spacerX(8)),
				layout.Rigid(func(gtx layout.Context) layout.Dimensions {
					button := material.Button(ui.theme, &ui.nextButton, "Next")
					button.Background = gioPanel
					button.Color = gioText
					return button.Layout(gtx)
				}),
			)
		})
	})
}

func (ui *gioFrontend) layoutStatus(gtx layout.Context) layout.Dimensions {
	return fill(gtx, gioPanel, func(gtx layout.Context) layout.Dimensions {
		return layout.Inset{Left: 14, Right: 14, Top: 6, Bottom: 6}.Layout(gtx, func(gtx layout.Context) layout.Dimensions {
			message := ui.status
			c := gioMuted
			if ui.loading {
				message = "Loading…"
			}
			if ui.errText != "" {
				message, c = ui.errText, gioDanger
			}
			if message == "" {
				message = "Gio renderer · build with -tags gio"
			}
			label := material.Caption(ui.theme, message)
			label.Color = c
			label.MaxLines = 1
			return label.Layout(gtx)
		})
	})
}

func (ui *gioFrontend) openDemo() {
	ui.async(func() (func(), error) {
		status, err := ui.backend.OpenDemoSession()
		if err != nil {
			return nil, err
		}
		tables, err := ui.backend.SessionListTables(status.ID)
		if err != nil {
			return nil, err
		}
		return func() {
			ui.session = status
			ui.setTables(tables)
			ui.status = "Connected to " + status.Name
			if len(tables) > 0 {
				ui.active = 0
				ui.loadActiveTable()
			}
		}, nil
	})
}

func (ui *gioFrontend) reloadTables() {
	id := ui.session.ID
	ui.async(func() (func(), error) {
		tables, err := ui.backend.SessionListTables(id)
		if err != nil {
			return nil, err
		}
		return func() {
			ui.setTables(tables)
			if len(tables) == 0 {
				ui.active = -1
			} else if ui.active < 0 || ui.active >= len(tables) {
				ui.active = 0
			}
			if ui.active >= 0 {
				ui.loadActiveTable()
			}
			ui.status = "Table list refreshed"
		}, nil
	})
}

func (ui *gioFrontend) setTables(tables []TableSummary) {
	ui.tables = tables
	ui.tableButtons = make([]widget.Clickable, len(tables))
}

func (ui *gioFrontend) loadActiveTable() {
	if ui.loading || ui.active < 0 || ui.active >= len(ui.tables) {
		return
	}
	table := ui.tables[ui.active]
	id, page := ui.session.ID, ui.page
	filter := strings.TrimSpace(ui.filterEditor.Text())
	sortCol, sortDir := ui.sortCol, ui.sortDir

	ui.async(func() (func(), error) {
		data, err := ui.backend.SessionGetTableData(id, table.Schema, table.Name, gioPageSize, page*gioPageSize, filter, sortCol, sortDir)
		if err != nil {
			return nil, err
		}
		return func() {
			ui.data = data
			ui.ensureHeaderButtons()
			ui.status = "Loaded " + table.Schema + "." + table.Name
		}, nil
	})
}

func (ui *gioFrontend) toggleSort(column string) {
	if ui.loading {
		return
	}
	if ui.sortCol != column {
		ui.sortCol, ui.sortDir = column, "asc"
	} else if ui.sortDir == "asc" {
		ui.sortDir = "desc"
	} else {
		ui.sortCol, ui.sortDir = "", ""
	}
	ui.page = 0
	ui.loadActiveTable()
}

func (ui *gioFrontend) ensureHeaderButtons() {
	if len(ui.headerButtons) != len(ui.data.Columns) {
		ui.headerButtons = make([]widget.Clickable, len(ui.data.Columns))
	}
}

func gioCellText(value any) string {
	if value == nil {
		return "NULL"
	}
	switch v := value.(type) {
	case []byte:
		return string(v)
	case map[string]any, []any:
		if encoded, err := json.Marshal(v); err == nil {
			return string(encoded)
		}
	}
	return fmt.Sprint(value)
}

func fixedWidth(gtx layout.Context, width unit.Dp, child layout.Widget) layout.Dimensions {
	px := gtx.Dp(width)
	gtx.Constraints.Min.X, gtx.Constraints.Max.X = px, px
	return child(gtx)
}

func fill(gtx layout.Context, c color.NRGBA, child layout.Widget) layout.Dimensions {
	return layout.Background{}.Layout(gtx,
		func(gtx layout.Context) layout.Dimensions {
			size := gtx.Constraints.Min
			paint.FillShape(gtx.Ops, c, clip.Rect{Max: size}.Op())
			return layout.Dimensions{Size: size}
		},
		child,
	)
}

func spacerX(size unit.Dp) layout.Widget {
	return func(gtx layout.Context) layout.Dimensions {
		return layout.Spacer{Width: size}.Layout(gtx)
	}
}

func spacerY(size unit.Dp) layout.Widget {
	return func(gtx layout.Context) layout.Dimensions {
		return layout.Spacer{Height: size}.Layout(gtx)
	}
}
