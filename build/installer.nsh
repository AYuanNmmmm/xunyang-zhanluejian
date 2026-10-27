; 巡洋战略舰 —— NSIS 安装器钩子
;
; 目的：① 让用户自己选安装位置 ② 默认不要落在系统盘
;
; 两个坑，已踩过：
;
; 坑一：挂载点必须用 customInit，不能用 preInit。
;   electron-builder 的 installer.nsi 里顺序是
;       preInit → initMultiUser(setInstallModePerUser) → customInit
;   setInstallModePerUser 会把 $INSTDIR 重设为 %LOCALAPPDATA%\Programs\<appname>，
;   写在 preInit 里的修改会被它覆盖掉（实测：装到 C 盘去了）。
;   它自己也实现了 /D= 覆盖，所以「用户显式指定」这条路径照常有效。
;
; 坑二：不要在 custom script 里定义 Function。
;   include 的文件最终落在某个 Section 范围内，Function 会被当成 section 回调，
;   makensis 报 warning 6010 "not referenced"，而 electron-builder 把 warning 当 error 直接失败。
;   所以下面整段逻辑全部内联展开。

!macro customInit
  Push $0
  Push $1

  ; 只在「默认值落在系统盘」时才挪走：
  ;   · 首次安装   → $INSTDIR 是 %LOCALAPPDATA%\Programs\... (C:) → 挪 ✓
  ;   · /D= 指定了 → 只要不是 C 盘就原样保留（用户说了算）
  ;   · 升级安装   → 上次若已装在 D/E/G，也不是 C 盘，保持不动
  StrCpy $1 "$INSTDIR" 2                    ; 取盘符
  ${If} $1 == "C:"
    StrCpy $9 ""

    ; ---- 依次试 D → E → G，取第一个能写的盘 ----
    ; 判「能写」的办法：建目录 → 建一个临时文件再删掉，不碰任何已有内容

    StrCpy $0 "D:\Program Files"
    ClearErrors
    CreateDirectory "$0"
    IfErrors XY_try_e
    FileOpen $1 "$0\_巡洋战略舰写权限测试.tmp" w
    IfErrors XY_try_e
    FileClose $1
    Delete "$0\_巡洋战略舰写权限测试.tmp"
    StrCpy $9 "$0"

    XY_try_e:
    StrCmp $9 "" 0 XY_picked
    StrCpy $0 "E:\Program Files"
    ClearErrors
    CreateDirectory "$0"
    IfErrors XY_try_g
    FileOpen $1 "$0\_巡洋战略舰写权限测试.tmp" w
    IfErrors XY_try_g
    FileClose $1
    Delete "$0\_巡洋战略舰写权限测试.tmp"
    StrCpy $9 "$0"

    XY_try_g:
    StrCmp $9 "" 0 XY_picked
    StrCpy $0 "G:\Program Files"
    ClearErrors
    CreateDirectory "$0"
    IfErrors XY_picked
    FileOpen $1 "$0\_巡洋战略舰写权限测试.tmp" w
    IfErrors XY_picked
    FileClose $1
    Delete "$0\_巡洋战略舰写权限测试.tmp"
    StrCpy $9 "$0"

    XY_picked:
    StrCmp $9 "" XY_keep
    StrCpy $INSTDIR "$9\巡洋战略舰"
    XY_keep:
  ${EndIf}

  Pop $1
  Pop $0
!macroend
