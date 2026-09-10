# Nautilus（GNOME 文件）右键菜单：在 Term Manager 中打开。
# 由 term-manager 的 deb 安装到 /usr/share/nautilus-python/extensions/，
# 依赖 python3-nautilus；Nautilus 42（3.0 API）与 43+（4.0 API）兼容。
import os
import shutil
import subprocess

import gi

try:
    gi.require_version("Nautilus", "4.0")  # Nautilus 43+
except ValueError:
    gi.require_version("Nautilus", "3.0")  # Nautilus 42 / Ubuntu 22.04

from gi.repository import GObject, Nautilus  # noqa: E402

MENU_LABEL = "在 Term Manager 中打开"
MENU_NAME = "TermManagerNautilusExtension::open_in_term_manager"
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


class TermManagerMenuProvider(GObject.GObject, Nautilus.MenuProvider):
    def _make_item(self, path):
        item = Nautilus.MenuItem(name=MENU_NAME, label=MENU_LABEL, tip="", icon="")
        item.connect("activate", lambda *_args, p=path: _launch(p))
        return item

    def get_file_items(self, *args):
        # 4.0: args == (files,)；3.0: args == (window, files)
        try:
            files = args[-1]
            for file_info in files or []:
                path = _dir_path(file_info)
                if path:
                    return [self._make_item(path)]
            return []
        except Exception:
            return []

    def get_background_items(self, *args):
        # 4.0: args == (current_folder,)；3.0: args == (window, current_folder)
        try:
            path = _dir_path(args[-1])
            return [self._make_item(path)] if path else []
        except Exception:
            return []
