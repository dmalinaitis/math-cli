-- Math CLI ↔ WezTerm bridge.
--
-- mathcli sends its theme to the terminal as a user var (OSC 1337 SetUserVar=MATHCLI_THEME=…).
-- This handler applies it to that window only — background/gradient, opacity, acrylic blur, cursor,
-- selection and title bar — and removes the overrides again when mathcli exits (empty value).
--
-- Installed to ~/.mathcli/wezterm.lua by mathcli; enable it by adding to your .wezterm.lua:
--   pcall(dofile, wezterm.home_dir .. "/.mathcli/wezterm.lua")
local wezterm = require("wezterm")

local KEYS = {
  "colors", "window_background_opacity", "text_background_opacity",
  "win32_system_backdrop", "window_background_gradient", "window_frame",
}

local function clear(o)
  for _, k in ipairs(KEYS) do o[k] = nil end
end

wezterm.on("user-var-changed", function(window, pane, name, value)
  if name ~= "MATHCLI_THEME" then return end
  local o = window:get_config_overrides() or {}
  clear(o)

  if value ~= nil and value ~= "" then
    local ok, t = pcall(wezterm.json_parse, value)
    if ok and type(t) == "table" then
      local bar = { bg_color = t.titlebar, fg_color = t.foreground }
      o.colors = {
        background = t.background,
        foreground = t.foreground,
        cursor_bg = t.cursor, cursor_border = t.cursor, cursor_fg = t.background,
        selection_bg = t.selection, selection_fg = t.foreground,
        tab_bar = {
          background = t.titlebar,
          active_tab = bar,
          inactive_tab = { bg_color = t.titlebar, fg_color = t.dim },
          inactive_tab_hover = bar,
          new_tab = { bg_color = t.titlebar, fg_color = t.dim },
        },
      }
      if t.gradient then
        o.window_background_gradient = { orientation = "Vertical", colors = t.gradient }
      end
      o.window_background_opacity = t.opacity
      o.text_background_opacity = t.opacity -- panels go translucent with the window
      if t.opacity < 1 and t.blur then o.win32_system_backdrop = "Acrylic" end

      -- Keep the user's title-bar font; only recolour it.
      local frame = {}
      local okc, eff = pcall(function() return window:effective_config().window_frame end)
      if okc and type(eff) == "table" then for k, v in pairs(eff) do frame[k] = v end end
      frame.active_titlebar_bg = t.titlebar
      frame.inactive_titlebar_bg = t.titlebar
      o.window_frame = frame
    end
  end
  window:set_config_overrides(o)
end)
