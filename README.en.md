# EasyEDA PCB Design

**English** · **[中文](README.md)**

## Install prompt (copy into your Agent)

```text
Please install the easyeda-pcb-design package in this workspace as an Agent Skill I can use.

Requirements:
1. Install it using this repo’s skill layout (entry point: SKILL.md).
2. After install, confirm the skill name is available and tell me how to invoke it later.
3. Do not change the skill’s design rules or reference docs unless a path/config tweak is required for install.
4. If the companion easyeda-api skill is also required, say whether it’s ready and what’s missing.

When done, in one sentence tell me how to ask you next time to design or review an EasyEDA PCB with this skill.
```

## What this is

Use AI with **EasyEDA Pro** (JLCPCB EDA) to design schematics and PCBs—from everyday boards to high-speed and impedance-aware work—step by step, with review when you need it.

## What you can do

- Draw schematics, place parts, route, and pour copper
- Run a design review pass so fewer items are missed
- Load high-speed guidance only when the board actually needs it

## Before you start

- **EasyEDA Pro** installed and open
- The companion EasyEDA API capability set up for live design work
- An AI tool that can install a local skill

## After install

Describe your board in plain language, for example:

- “Use the EasyEDA PCB design skill to build an STM32 minimum system.”
- “Review the current board for obvious issues.”
- “This board has high-speed USB—use the extra checks only if needed.”
