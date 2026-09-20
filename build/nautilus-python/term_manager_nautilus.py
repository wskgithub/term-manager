# Nautilus（GNOME 文件）右键菜单：在 Term Manager 中打开 / 启动 AI Agent CLI /
# 复制当前路径。由 term-manager 的 deb/rpm 安装到 /usr/share/nautilus-python/extensions/，
# 依赖 python3-nautilus；Nautilus 42（3.0 API）与 43+（4.0 API）兼容。
#
# 「在 Term Manager 中打开」为父项（形态对齐「新建文档」）：首子项为原打开
# 动作，其后列出自动发现的 AI Agent CLI（点击 = 以 --open-dir/--agent 在该
# 目录拉起 Term Manager）。agent 注册表与主进程 TS 同源——读本目录下的
# term-manager-agents.json（fpm 从 src/shared/agents.json 原样拷入）；设置联动
#（隐藏/自定义 agent）读安装版 userData 的 settings.json，缺失或损坏一律回退。
import glob
import json
import os
import re
import shutil

import gi

try:
    gi.require_version("Nautilus", "4.0")  # Nautilus 43+，宿主进程是 GTK4
    _NAUTILUS_API = "4.0"
except ValueError:
    gi.require_version("Nautilus", "3.0")  # Nautilus 42 / Ubuntu 22.04，宿主进程是 GTK3
    _NAUTILUS_API = "3.0"

from gi.repository import Gio, GObject, Nautilus  # noqa: E402

MENU_LABEL_OPEN = "在 Term Manager 中打开"
MENU_NAME_OPEN = "TermManagerNautilusExtension::open_in_term_manager"
MENU_NAME_SUB_TERMINAL = "TermManagerNautilusExtension::open_terminal"
MENU_LABEL_AGENTS_NONE = "未检测到已安装的 AI Agent"
MENU_NAME_AGENTS_NONE = "TermManagerNautilusExtension::agents_none"
MENU_LABEL_COPY = "复制当前路径"
MENU_NAME_COPY = "TermManagerNautilusExtension::copy_current_path"
FALLBACK_BIN = "/opt/term-manager/term-manager"

# 注册表/设置文件位置：json 与本扩展同目录由 fpm 装入；设置在安装版 userData
#（开发态 electron 直跑时 userData 是 ~/.config/Electron，读不到属预期——
# 本扩展只随安装版分发生效）
_HERE = os.path.dirname(os.path.abspath(__file__))
AGENTS_JSON = os.path.join(_HERE, "term-manager-agents.json")
SETTINGS_JSON = os.path.join(os.path.expanduser("~"), ".config", "term-manager", "settings.json")

# 自定义 agent 命令 token 白名单：与主进程 settings.ts 的 AGENT_ARG_RE 同口径
_ARG_RE = re.compile(r"^[A-Za-z0-9_./=,:@%+-]+$")


def _find_executable():
    # TERM_MANAGER_BIN 供开发调试时指向本地构建
    override = os.environ.get("TERM_MANAGER_BIN")
    if override and os.path.exists(override):
        return override
    found = shutil.which("term-manager")
    if found:
        return found
    return FALLBACK_BIN if os.path.exists(FALLBACK_BIN) else None


def _load_registry():
    """agent 定义清单：内置（agents.json，字段宽松校验）+ 设置页自定义
    （settings.json，token 过白名单），应用 hiddenAgents 过滤。任何读取/
    解析失败都回退「只有内置、无隐藏」——右键菜单绝不能因配置损坏而报错"""
    builtin = []
    extra_dirs = []
    hidden = set()
    custom = []
    try:
        with open(AGENTS_JSON, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            for a in data.get("agents") or []:
                if (
                    isinstance(a, dict)
                    and isinstance(a.get("id"), str)
                    and a["id"]
                    and isinstance(a.get("name"), str)
                    and a["name"]
                    and isinstance(a.get("argv"), list)
                    and a["argv"]
                    and all(isinstance(x, str) for x in a["argv"])
                ):
                    builtin.append(a)
            for d in data.get("extraBinDirs") or []:
                if isinstance(d, str) and d:
                    extra_dirs.append(d)
    except Exception:
        pass
    try:
        with open(SETTINGS_JSON, "r", encoding="utf-8") as f:
            s = json.load(f)
        if isinstance(s, dict):
            for h in s.get("hiddenAgents") or []:
                if isinstance(h, str):
                    hidden.add(h)
            for c in s.get("customAgents") or []:
                if (
                    isinstance(c, dict)
                    and isinstance(c.get("id"), str)
                    and c["id"]
                    and isinstance(c.get("name"), str)
                    and c["name"]
                    and isinstance(c.get("argv"), list)
                    and c["argv"]
                    and len(c["argv"]) <= 8
                    and all(isinstance(x, str) and x and _ARG_RE.match(x) for x in c["argv"])
                ):
                    custom.append(c)
    except Exception:
        pass
    defs = [a for a in builtin if a["id"] not in hidden]
    known = {a["id"] for a in defs}
    # 自定义 id 撞内置时内置优先（与应用内菜单同一语义）
    defs += [c for c in custom if c["id"] not in hidden and c["id"] not in known]
    return defs, extra_dirs


def _extra_bin_dirs(extra_dirs):
    """把注册表 extraBinDirs（HOME 相对，支持 '*' 单段通配——nvm 版本目录
    随 Node 升级漂移）展开为绝对目录列表"""
    home = os.path.expanduser("~")
    out = []
    for d in extra_dirs:
        if "*" in d:
            out.extend(g for g in sorted(glob.glob(os.path.join(home, d))) if os.path.isdir(g))
        else:
            p = os.path.join(home, d)
            if os.path.isdir(p):
                out.append(p)
    return out


def _agent_available(argv0, extra_dirs):
    """可执行文件可寻址：$PATH（Nautilus 跑在用户登录会话，但图形会话常缺
    nvm/.opencode 等目录，靠 extraBinDirs 兜底）→ 注册表补充的全局 bin 目录；
    含 / 视为路径直接探测"""
    if not argv0:
        return False
    if "/" in argv0:
        return os.path.exists(argv0)
    if shutil.which(argv0):
        return True
    for d in _extra_bin_dirs(extra_dirs):
        if os.path.exists(os.path.join(d, argv0)):
            return True
    return False


def _dir_path(file_info):
    """仅接受本地（非回收站/网络/Recent）目录，其余返回 None"""
    try:
        if file_info is None or not file_info.is_directory():
            return None
        location = file_info.get_location()
        if location is None or location.get_uri_scheme() != "file":
            return None
        return location.get_path() or None
    except Exception:
        return None


def _launch(path, agent_id=None):
    binary = _find_executable()
    if not binary:
        return
    # 参数一律列表形、flag 与值分立（不经 shell、零拼接）：路径只作为独立 argv
    # 项存在，主进程 extractOpenDir/extractAgentArg 支持两段式形态。
    # Gio.Subprocess 是 GLib 生态的派生原语（即发即弃），stdout/stderr 静默到
    # /dev/null 防 fd 泄漏
    argv = [binary, "--open-dir", path]
    if agent_id:
        argv += ["--agent", agent_id]
    try:
        Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
        )
    except Exception:
        pass


def _copy_to_clipboard(text):
    """把文本写入系统剪贴板；跟随宿主 Nautilus 的 GUI 工具包选 API。

    4.0 API（GTK4）用 Gdk.Clipboard——注意其绑定为 set(value: GObject.Value)，
    直接传字符串由 PyGObject 包装成 GValue 即可；若误传 ContentProvider 会被
    二次包装成对象值，剪贴板内容将无法按文本读取（本机已实测踩坑）。
    3.0 API（GTK3）用 Gtk.Clipboard；两套剪贴板对象都依赖宿主的 Gtk/Gdk，
    所以按需导入写进分支里。
    """
    try:
        from gi.repository import Gdk  # noqa: E402

        display = Gdk.Display.get_default()
        if display is None:
            return False
        if _NAUTILUS_API == "4.0":
            display.get_clipboard().set(text)
        else:
            from gi.repository import Gtk  # noqa: E402

            clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
            clipboard.set_text(text, -1)
            clipboard.store()
        return True
    except Exception:
        return False


class TermManagerMenuProvider(GObject.GObject, Nautilus.MenuProvider):
    def _make_items(self, path):
        # 父项挂 submenu 后 GNOME 不再对父项本身发 activate：原打开动作下移为
        # 首子项「打开终端标签页」（常见路径仍两次点击可达），其后为 agent 子项
        submenu = Nautilus.Menu()
        terminal_item = Nautilus.MenuItem(
            name=MENU_NAME_SUB_TERMINAL, label="打开终端标签页", tip="", icon=""
        )
        terminal_item.connect("activate", lambda *_a, p=path: _launch(p))
        submenu.append_item(terminal_item)

        defs, extra_dirs = _load_registry()
        avail = [d for d in defs if _agent_available(d["argv"][0], extra_dirs)]
        if not avail:
            none_item = Nautilus.MenuItem(
                name=MENU_NAME_AGENTS_NONE, label=MENU_LABEL_AGENTS_NONE, tip="", icon=""
            )
            # 禁用走 props（typelib 无 set_sensitive 方法，sensitive 是合法属性；
            # submenu 属性在 3.0 typelib 里叫 menu，故挂子菜单只用 set_submenu）
            none_item.props.sensitive = False
            submenu.append_item(none_item)
        for d in avail:
            item = Nautilus.MenuItem(
                name="TermManagerNautilusExtension::agent::" + d["id"],
                label=d["name"],
                tip="在此目录启动",
                icon="",
            )
            item.connect("activate", lambda *_a, p=path, a=d["id"]: _launch(p, a))
            submenu.append_item(item)

        open_item = Nautilus.MenuItem(name=MENU_NAME_OPEN, label=MENU_LABEL_OPEN, tip="", icon="")
        # 挂子菜单必须用 set_submenu()：Nautilus 42（3.0 API）的 PyGObject GProps
        # 上没有 submenu 属性（props.submenu 会 AttributeError，且异常会被
        # get_file_items 的兜底 try/except 吞掉 → 整组菜单静默消失）
        open_item.set_submenu(submenu)

        copy_item = Nautilus.MenuItem(
            name=MENU_NAME_COPY, label=MENU_LABEL_COPY, tip="", icon=""
        )
        copy_item.connect("activate", lambda *_a, p=path: _copy_to_clipboard(p))
        return [open_item, copy_item]

    def get_file_items(self, *args):
        # 4.0: args == (files,)；3.0: args == (window, files)
        try:
            files = args[-1]
            for file_info in files or []:
                path = _dir_path(file_info)
                if path:
                    return self._make_items(path)
            return []
        except Exception:
            return []

    def get_background_items(self, *args):
        # 4.0: args == (current_folder,)；3.0: args == (window, current_folder)
        try:
            path = _dir_path(args[-1])
            return self._make_items(path) if path else []
        except Exception:
            return []
