"""dev-sim package — Claude-powered CLI for GitHub and local git workflows.

The `dev-sim` console script (see pyproject.toml) runs `dev_sim.cli:main`, which loads
env via `dev_sim.config` and calls `dev_sim.coding_agent.run_coding_agent` for the
Anthropic tool loop.
"""

__version__ = "0.1.0"
