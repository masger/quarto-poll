-- quarto-poll: live afstemning i revealjs-slides.
-- Et ::: {.poll} div bliver til et slide med QR-kode og søjlediagram,
-- der opdaterer live via Firebase Realtime Database (eller mock-serveren i dev/).

local injected = false
local counter = 0

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
    color = get("color") or "",
    lang = get("lang") or "da",
    closeOnLeave = (get("close-on-leave") ~= "false"),
  }
  quarto.doc.include_text("in-header", "<script>window.QUARTO_POLL = " .. json(cfg) .. ";</script>")
  quarto.doc.add_html_dependency({
    name = "quarto-poll",
    version = "0.3.1",
    scripts = { "qrcode.min.js", "poll.js" },
    stylesheets = { "poll.css" },
  })
end

local function results_div(div)
  local id = div.attributes["poll"] or div.attributes["for"] or ""
  return pandoc.RawBlock("html",
    '<div class="quarto-poll-results" data-poll-id="' .. esc(id) .. '"></div>')
end

local function poll_div(div)
  counter = counter + 1
  local id = div.attributes["poll-id"]
  if not id and div.identifier ~= "" then id = div.identifier end
  if not id then id = "poll" .. counter end

  local question_html, question_text, options = "", "", {}
  local correct, quiz = nil, false
  for _, b in ipairs(div.content) do
    if b.t == "BulletList" or b.t == "OrderedList" then
      for _, item in ipairs(b.content) do
        local label = pandoc.utils.stringify(pandoc.Div(item))
        -- Task-list items (- [x] / - [ ]) mark a quiz; ☒ is the correct answer.
        -- Lua patterns work on bytes, so compare the UTF-8 sequences directly.
        local CHECKED, UNCHECKED = utf8.char(0x2612), utf8.char(0x2610) -- the characters Pandoc uses for [x] and [ ]
        local marker = label:sub(1, 3)
        if marker == CHECKED or marker == UNCHECKED then
          quiz = true
          label = label:sub(4):gsub("^%s+", "")
          if marker == CHECKED and correct == nil then correct = #options end
        end
        table.insert(options, label)
      end
    elseif question_html == "" then
      question_html = pandoc.write(pandoc.Pandoc({ b }), "html")
      question_text = pandoc.utils.stringify(b)
    end
  end
  if question_text == "" and div.attributes["question"] then
    question_text = div.attributes["question"]
    question_html = "<p>" .. esc(question_text) .. "</p>"
  end

  local qtype = div.attributes["type"] or (#options > 0 and "choice" or "text")
  if qtype ~= "choice" and qtype ~= "text" and qtype ~= "open" then
    quarto.log.warning("poll " .. id .. ": unknown type '" .. qtype .. "', using 'choice'")
    qtype = "choice"
  end
  if qtype == "choice" and #options == 0 then
    quarto.log.warning("poll " .. id .. ": type 'choice' needs a bullet list of options")
  end
  local auto = div.attributes["auto"] ~= "false"
  local results = div.attributes["results"] == "hidden" and "hidden" or "live"
  if div.attributes["correct"] then
    quiz = true
    correct = tonumber(div.attributes["correct"]) - 1
  end
  if quiz and (qtype ~= "choice" or correct == nil or correct < 0 or correct >= #options) then
    quarto.log.warning("poll " .. id .. ": a quiz needs a choice list with exactly one '- [x]' item (or correct=\"n\")")
    quiz = false
  end
  local points = tonumber(div.attributes["points"]) or 1

  local html = '<div class="quarto-poll" data-poll-id="' .. esc(id) .. '"'
    .. ' data-type="' .. esc(qtype) .. '"'
    .. ' data-auto="' .. tostring(auto) .. '"'
    .. ' data-results="' .. results .. '"'
    .. ' data-quiz="' .. tostring(quiz) .. '"'
    .. ' data-correct="' .. (quiz and tostring(correct) or "") .. '"'
    .. ' data-points="' .. tostring(points) .. '"'
    .. ' data-options="' .. esc(json(options)) .. '"'
    .. ' data-question="' .. esc(question_text) .. '">'
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
        return results_div(div)
      elseif div.classes:includes("poll-scores") then
        found = true
        local top = tonumber(div.attributes["top"]) or 10
        return pandoc.RawBlock("html", '<div class="quarto-poll-scores" data-top="' .. top .. '"></div>')
      end
    end,
  })
  if found then inject(doc.meta) end
  return doc
end
