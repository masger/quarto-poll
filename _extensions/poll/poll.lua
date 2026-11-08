-- quarto-poll: live audience polling in Quarto revealjs slides.
-- A ::: {.poll} div becomes a slide with a QR code and a live chart that updates
-- through a Firebase Realtime Database (or dev/mock_firebase.py while developing).

local injected = false
local counter = 0
local CHECKED, UNCHECKED = utf8.char(0x2612), utf8.char(0x2610) -- the characters Pandoc uses for [x] and [ ]
local TYPES = { choice = true, multi = true, scale = true, rank = true, text = true, open = true }

local function str(v)
  if v == nil then return nil end
  return pandoc.utils.stringify(v)
end

local function json(t)
  if quarto and quarto.json and quarto.json.encode then return quarto.json.encode(t) end
  return pandoc.json.encode(t)
end

local function esc(s)
  s = s:gsub("&", "&amp;")
  s = s:gsub('"', "&quot;")
  s = s:gsub("<", "&lt;")
  return s
end

local function warn(id, msg)
  quarto.log.warning("quarto-poll, poll '" .. id .. "': " .. msg)
end

-- Pandoc parses YAML header values as Markdown, so a password such as "a$b*c$" would lose
-- its dollar signs. The config file is therefore read verbatim: simple `key: value` lines,
-- optionally indented under `poll:`, with optional quotes around the value.
local function read_config_file(path)
  local f = io.open(path, "r")
  if not f then return {} end
  local out = {}
  for line in f:lines() do
    local key, value = line:match("^%s*([%w%-]+):%s*(.-)%s*$")
    if key and key ~= "poll" and value ~= "" then
      local quoted = value:match('^"(.*)"$') or value:match("^'(.*)'$")
      if quoted then
        value = quoted
      else
        value = value:gsub("%s+#.*$", "")
      end
      out[key] = value
    end
  end
  f:close()
  return out
end

local function inject(meta)
  if injected then return end
  injected = true
  local p = meta.poll or {}
  local file = str(p.file) or "_poll.yml"
  local raw = {}
  if file ~= "none" and file ~= "" then
    local dir = pandoc.path.directory(quarto.doc.input_file or "")
    raw = read_config_file(pandoc.path.join({ dir, file }))
  end
  -- Header values win; the file fills in what the header does not set (typically the password).
  local function get(key)
    local v = str(p[key])
    if v ~= nil and v ~= "" then return v end
    return raw[key]
  end
  local cfg = {
    db = get("db") or "",
    room = get("room") or "",
    apiKey = get("api-key") or "",
    email = get("email") or "",
    password = get("password") or "",
    audience = get("audience") or "https://masger.github.io/poll/",
    audienceMode = get("audience-mode") or "stream",
    color = get("color") or "",
    lang = get("lang") or "da",
    closeOnLeave = (get("close-on-leave") ~= "false"),
  }
  quarto.doc.include_text("in-header", "<script>window.QUARTO_POLL = " .. json(cfg) .. ";</script>")
  quarto.doc.add_html_dependency({
    name = "quarto-poll",
    version = "0.4.0",
    scripts = { "qrcode.min.js", "poll.js" },
    stylesheets = { "poll.css" },
  })
end

local function split_list(s)
  local out = {}
  for part in (s or ""):gmatch("[^,]+") do
    part = part:gsub("^%s+", ""):gsub("%s+$", "")
    if part ~= "" then table.insert(out, part) end
  end
  return out
end

local function poll_div(div)
  counter = counter + 1
  local a = div.attributes
  local id = a["poll-id"]
  if not id and div.identifier ~= "" then id = div.identifier end
  if not id then id = "poll" .. counter end

  local question_html, question_text, options = "", "", {}
  local checked, has_boxes = {}, false
  for _, b in ipairs(div.content) do
    if b.t == "BulletList" or b.t == "OrderedList" then
      for _, item in ipairs(b.content) do
        local label = pandoc.utils.stringify(pandoc.Div(item))
        local marker = label:sub(1, 3)
        if marker == CHECKED or marker == UNCHECKED then
          has_boxes = true
          label = label:sub(4):gsub("^%s+", "")
          if marker == CHECKED then table.insert(checked, #options) end
        end
        table.insert(options, label)
      end
    elseif question_html == "" then
      question_html = pandoc.write(pandoc.Pandoc({ b }), "html")
      question_text = pandoc.utils.stringify(b)
    end
  end
  if question_text == "" and a["question"] then
    question_text = a["question"]
    question_html = "<p>" .. esc(question_text) .. "</p>"
  end

  local qtype = a["type"] or (#options > 0 and "choice" or "text")
  if not TYPES[qtype] then
    warn(id, "unknown type '" .. qtype .. "', using 'choice'")
    qtype = "choice"
  end

  local m = {
    id = id,
    question = question_text,
    type = qtype,
    options = options,
    auto = a["auto"] ~= "false",
    results = (a["results"] == "hidden") and "hidden" or "live",
    quiz = false,
    points = tonumber(a["points"]) or 1,
    time = tonumber(a["time"]) or 0,
    speed = a["speed"] == "true",
  }

  if qtype == "scale" then
    local min = tonumber(a["min"]) or 1
    local max = tonumber(a["max"]) or 5
    if #options == 0 then
      for v = min, max do table.insert(options, tostring(v)) end
    end
    m.min = min
    m.options = options
  end
  if (qtype == "choice" or qtype == "multi" or qtype == "rank" or qtype == "scale") and #m.options < 2 then
    warn(id, "type '" .. qtype .. "' needs a bullet list with at least two options")
  end

  -- Quiz: '- [x]' items, correct="n" (1-based, several allowed for multi) or answers="a, b" for text.
  if a["correct"] then
    checked = {}
    for _, n in ipairs(split_list(a["correct"])) do table.insert(checked, tonumber(n) - 1) end
    has_boxes = true
  end
  if has_boxes and (qtype == "choice" or qtype == "multi") then
    if qtype == "choice" and #checked == 1 then
      m.quiz = true
      m.correct = checked[1]
    elseif qtype == "multi" and #checked >= 1 then
      m.quiz = true
      m.correct = checked
    else
      warn(id, "a choice quiz needs exactly one '- [x]' item; a multi quiz needs at least one")
    end
  elseif has_boxes then
    warn(id, "'- [x]' is only supported for type choice and multi")
  end
  if a["answers"] then
    if qtype == "text" then
      m.quiz = true
      m.correct = {}
      for _, s in ipairs(split_list(a["answers"])) do table.insert(m.correct, s:lower()) end
    else
      warn(id, "answers=\"...\" is only supported for type text")
    end
  end
  if m.speed and not (m.quiz and m.time > 0) then
    warn(id, "speed=\"true\" needs a quiz with time=\"seconds\"; ignoring")
    m.speed = false
  end

  local html = '<div class="quarto-poll" data-poll-id="' .. esc(id) .. '"'
    .. ' data-type="' .. esc(qtype) .. '"'
    .. ' data-results="' .. m.results .. '"'
    .. ' data-poll="' .. esc(json(m)) .. '">'
    .. '<div class="poll-question">' .. question_html .. '</div>'
    .. '<div class="poll-body">'
    .. '<div class="poll-left"><div class="poll-qr"></div><div class="poll-join"></div></div>'
    .. '<div class="poll-right"><div class="poll-status"></div><div class="poll-chart"></div></div>'
    .. '</div></div>'
  return pandoc.RawBlock("html", html)
end

function Pandoc(doc)
  if not quarto.doc.is_format("revealjs") then return nil end
  local found = false
  doc.blocks = doc.blocks:walk({
    Div = function(div)
      if div.classes:includes("poll") then
        found = true
        return poll_div(div)
      elseif div.classes:includes("poll-results") then
        found = true
        local id = div.attributes["poll"] or div.attributes["for"] or ""
        return pandoc.RawBlock("html", '<div class="quarto-poll-results" data-poll-id="' .. esc(id) .. '"></div>')
      elseif div.classes:includes("poll-scores") then
        found = true
        local top = tonumber(div.attributes["top"]) or 10
        local podium = div.attributes["podium"] ~= "false"
        return pandoc.RawBlock("html", '<div class="quarto-poll-scores" data-top="' .. top .. '" data-podium="' .. tostring(podium) .. '"></div>')
      end
    end,
  })
  if found then inject(doc.meta) end
  return doc
end
