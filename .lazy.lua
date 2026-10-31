return {
  {
    "nvim-tree/nvim-tree.lua",
    optional = true,
    opts = { filters = { custom = { "^node_modules$" } } },
  },
  {
    "stevearc/oil.nvim",
    optional = true,
    opts = {
      view_options = {
        is_always_hidden = function(name)
          return name == "node_modules"
        end,
      },
    },
  },
}
