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

local function inject(meta)
  if injected then return end
  injected = true
  local p = meta.poll or {}
  local cfg = {
    db = str(p.db) or "",
    room = str(p.room) or "",
    apiKey = str(p["api-key"]) or "",
    email = str(p.email) or "",
    password = str(p.password) or "",
    audience = str(p.audience) or "https://masger.github.io/poll/",
    color = str(p.color) or "",
    lang = str(p.lang) or "da",
    closeOnLeave = (str(p["close-on-leave"]) ~= "false"),
  }
  quarto.doc.include_text("in-header", "<script>window.QUARTO_POLL = " .. json(cfg) .. ";</script>")
  quarto.doc.add_html_dependency({
    name = "quarto-poll",
    version = "0.1.0",
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
  for _, b in ipairs(div.content) do
    if b.t == "BulletList" or b.t == "OrderedList" then
      for _, item in ipairs(b.content) do
        table.insert(options, pandoc.utils.stringify(pandoc.Div(item)))
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
  local auto = div.attributes["auto"] ~= "false"

  local html = '<div class="quarto-poll" data-poll-id="' .. esc(id) .. '"'
    .. ' data-type="' .. esc(qtype) .. '"'
    .. ' data-auto="' .. tostring(auto) .. '"'
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
      end
    end,
  })
  if found then inject(doc.meta) end
  return doc
end
