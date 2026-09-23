-- 0029 ARB-330: an approval made through the MCP server says so. It is still the signed-in
-- person's approval, through the same API routes and rights; only the channel differs.
alter type approval_channel add value if not exists 'mcp';
