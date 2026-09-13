# Nautilus（GNOME 文件）右键菜单：在 Term Manager 中打开 / 复制当前路径。
# 由 term-manager 的 deb 安装到 /usr/share/nautilus-python/extensions/，
# 依赖 python3-nautilus；Nautilus 42（3.0 API）与 43+（4.0 API）兼容。
import os
import shutil
import subprocess

import gi

try:
    gi.require_version("Nautilus", "4.0")  # Nautilus 43+，宿主进程是 GTK4
    _NAUTILUS_API = "4.0"
except ValueError:
    gi.require_version("Nautilus", "3.0")  # Nautilus 42 / Ubuntu 22.04，宿主进程是 GTK3
    _NAUTILUS_API = "3.0"

from gi.repository import GObject, Nautilus  # noqa: E402

MENU_LABEL_OPEN = "在 Term Manager 中打开"
MENU_NAME_OPEN = "TermManagerNautilusExtension::open_in_term_manager"
MENU_LABEL_COPY = "复制当前路径"
MENU_NAME_COPY = "TermManagerNautilusExtension::copy_current_path"
FALLBACK_BIN = "/opt/term-manager/term-manager"


def _find_executable():
    # TERM_MANAGER_BIN 供开发调试时指向本地构建
    override = os.environ.get("TERM_MANAGER_BIN")
    if override and os.path.exists(override):
        return override
    found = shutil.which("term-manager")
    if found:
        return found
    return FALLBACK_BIN if os.path.exists(FALLBACK_BIN) else None


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


def _launch(path):
    binary = _find_executable()
    if not binary:
        return
    try:
        subprocess.Popen(
            [binary, "--open-dir=" + path],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
    except OSError:
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
        open_item = Nautilus.MenuItem(
            name=MENU_NAME_OPEN, label=MENU_LABEL_OPEN, tip="", icon=""
        )
        open_item.connect("activate", lambda *_args, p=path: _launch(p))
        copy_item = Nautilus.MenuItem(
            name=MENU_NAME_COPY, label=MENU_LABEL_COPY, tip="", icon=""
        )
        copy_item.connect("activate", lambda *_args, p=path: _copy_to_clipboard(p))
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
