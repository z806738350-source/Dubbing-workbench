import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Check, ChevronDown, Trash2, X } from "lucide-react";

export const ErrorContext = createContext({ message: "", dismiss: () => {} });
const DialogDepth = createContext(0);
const dialogStack: { dialog: HTMLDialogElement; depth: number }[] = [];
function activateDialog() {
  const top = [...dialogStack].sort((a,b)=>a.depth-b.depth).at(-1)?.dialog;
  for(const entry of dialogStack)if(entry.dialog !== top && entry.dialog.open)entry.dialog.close();
  if(top && !top.open)top.showModal();
  return top;
}
export function ErrorBanner() {
  const { message, dismiss } = useContext(ErrorContext);
  return message ? <div className="error-banner" role="alert">
    <AlertCircle size={16} /><span>{message}</span>
    <button className="icon" aria-label="关闭错误提示" onClick={dismiss}><X size={16} /></button>
  </div> : null;
}

export function Dialog({
  title,
  children,
  onClose,
  wide = false,
  presentation = "modal",
  variant,
  footer,
  onBack,
  headerActions,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  presentation?: "modal" | "sidepanel" | "inline";
  variant?: "drawer" | "modal";
  footer?: ReactNode;
  onBack?: () => void;
  headerActions?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const depth=useContext(DialogDepth)+1;
  const mode=variant === "drawer" ? "sidepanel" : presentation;
  useEffect(() => {
    if(mode === "inline")return;
    const el = ref.current!;
    const origin=document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const entry={dialog:el,depth};dialogStack.push(entry);
    activateDialog();
    if(el.open)(el.querySelector<HTMLElement>("[autofocus], input:not([type=hidden]), textarea, [role=combobox], button") || el).focus({preventScroll:true});
    return () => {
      const index=dialogStack.indexOf(entry);if(index >= 0)dialogStack.splice(index,1);
      if(el.open)el.close();
      const active=activateDialog();
      if(origin?.isConnected && (!active || active.contains(origin)))origin.focus({preventScroll:true});
    };
  }, [mode,depth]);
  const content=<DialogDepth.Provider value={depth}>
    <div className="dialog-head">
      {onBack && <button className="text-button" onClick={onBack}>返回</button>}
      <h2>{title}</h2>
      {headerActions}
      <button className="icon" aria-label="关闭" onClick={onClose}><X size={18}/></button>
    </div>
    <ErrorBanner/>
    <div className="dialog-body">{children}</div>
    {footer && <div className="dialog-footer">{footer}</div>}
  </DialogDepth.Provider>;
  if(mode === "inline")return <section className="inline-panel" aria-label={title}>{content}</section>;
  return createPortal(
    <dialog
      ref={ref}
      className={"dialog" + (wide ? " wide" : "") + (mode === "sidepanel" ? " sidepanel" : "")}
      data-presentation={mode}
      tabIndex={-1}
      onCancel={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-label={title}
    >
      {content}
    </dialog>, document.body,
  );
}
export function Select({
  value,
  options,
  onChange,
  disabled = false,
  label,
  onOpen,
  onDelete,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  label: string;
  onOpen?: () => void;
  onDelete?: (value: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [cursor, setCursor] = useState(0);
  const [placement, setPlacement] = useState({
    top: 0,
    left: 0,
    width: 0,
    maxHeight: 280,
  });
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const listId = useRef("list-" + crypto.randomUUID());
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const height = Math.min(
        280,
        options.length * 44 + 8,
        window.innerHeight - 32,
      );
      const above =
        window.innerHeight - rect.bottom < height + 12 &&
        rect.top > height + 12;
      setPlacement({
        top: above ? rect.top - height - 4 : rect.bottom + 4,
        left: Math.max(
          8,
          Math.min(rect.left, window.innerWidth - rect.width - 8),
        ),
        width: rect.width,
        maxHeight: above
          ? height
          : Math.min(height, window.innerHeight - rect.bottom - 12),
      });
    };
    place();
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [open, options.length]);
  const focusOption = (index: number) => root.current?.querySelector<HTMLButtonElement>(`[data-choice-index="${index}"]`)?.focus();
  useEffect(() => {
    if (open && onDelete) focusOption(cursor);
  }, [open]);
  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div className="select" ref={root} onBlur={onDelete ? e => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
    } : undefined}>
      <button
        ref={trigger}
        className="select-trigger"
        type="button"
        role={onDelete ? undefined : "combobox"}
        aria-haspopup={onDelete ? "dialog" : "listbox"}
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId.current}
        aria-activedescendant={open && !onDelete ? `${listId.current}-${cursor}` : undefined}
        disabled={disabled || !options.length}
        onClick={() => {
          if (!open) onOpen?.();
          setCursor(
            Math.max(
              0,
              options.findIndex((o) => o.value === value),
            ),
          );
          setOpen(!open);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (open) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
            return;
          }
          if (e.key === "Tab") {
            if (!onDelete) setOpen(false);
            return;
          }
          if (!["ArrowDown", "ArrowUp", "Enter", "Home", "End"].includes(e.key))
            return;
          e.preventDefault();
          if (e.key === "Enter" && open) {
            choose(options[cursor].value);
            return;
          }
          if (!open) onOpen?.();
          setOpen(true);
          setCursor(
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? options.length - 1
                : !open
                  ? Math.max(
                      0,
                      options.findIndex((o) => o.value === value),
                    )
                  : (cursor + (e.key === "ArrowUp" ? -1 : 1) + options.length) %
                    options.length,
          );
        }}
      >
        <span>{options.find((o) => o.value === value)?.label || "请选择"}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div
          className="select-menu"
          style={{
            ...placement,
            position: "fixed",
            bottom: "auto",
            right: "auto",
          }}
          role={onDelete ? "dialog" : "listbox"}
          id={listId.current}
          aria-label={label}
          onKeyDown={onDelete ? e => {
            if (e.key === "Escape") {
              e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus();
            } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
              e.preventDefault();
              const next = e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : (cursor + (e.key === "ArrowUp" ? -1 : 1) + options.length) % options.length;
              setCursor(next); focusOption(next);
            }
          } : undefined}
        >
          {options.map((o, i) => onDelete ? <div className="select-option-row" key={o.value}>
            <button type="button" data-choice-index={i} aria-pressed={o.value === value} title={o.label}
              className={"select-option" + (i === cursor ? " cursor" : "")} disabled={disabled}
              onFocus={() => setCursor(i)} onClick={() => choose(o.value)}>
              <span>{o.label}</span>{o.value === value && <Check size={14} />}
            </button>
            <button type="button" className="select-delete" aria-label={"删除" + o.label} title={"删除" + o.label} disabled={disabled}
              onFocus={() => setCursor(i)} onClick={e => {
                e.stopPropagation(); setOpen(false); trigger.current?.focus(); onDelete(o.value);
              }}><Trash2 size={16} aria-hidden="true" /></button>
          </div> : (
            <button
              type="button"
              id={`${listId.current}-${i}`}
              key={o.value}
              role="option"
              tabIndex={-1}
              aria-selected={o.value === value}
              className={i === cursor ? "cursor" : ""}
              onPointerMove={() => setCursor(i)}
              onClick={() => choose(o.value)}
            >
              <span>{o.label}</span>
              {o.value === value && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="field">
      <label>
        {label}
        {children}
      </label>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}
export function Empty({
  icon,
  heading,
  children,
  action,
  className = "",
}: {
  icon: ReactNode;
  heading: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={"empty" + (className ? " " + className : "")}>
      <div className="empty-icon">{icon}</div>
      <h2>{heading}</h2>
      <p>{children}</p>
      {action && <div className="empty-actions">{action}</div>}
    </div>
  );
}
export function Status({
  kind,
  children,
}: {
  kind?: string;
  children: ReactNode;
}) {
  return (
    <span className={`status ${kind || ""}`}>
      <span className="status-dot" />
      {children}
    </span>
  );
}
export function Form({
  children,
  onSubmit,
  label,
  busy = false,
  successMessage,
  revision,
  primary = true,
}: {
  children: ReactNode;
  onSubmit: (form: FormData, expectedRevision?: number) => Promise<void | number>;
  label: string;
  busy?: boolean;
  successMessage?: string;
  revision?: number;
  primary?: boolean;
}) {
  const [baseRevision, setBaseRevision] = useState(revision);
  const [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [succeeded, setSucceeded] = useState(false);
  return (
    <form
      noValidate
      onChange={() => setSucceeded(false)}
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        setSucceeded(false);
        setPending(true);
        try {
          const savedRevision = await onSubmit(new FormData(e.currentTarget), baseRevision);
          if (typeof savedRevision === "number") setBaseRevision(savedRevision);
          setSucceeded(true);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setPending(false);
        }
      }}
    >
      {children}
      {revision !== baseRevision && <p className="warning">资料已更新，当前输入仍保留。请复制需要保留的修改后关闭并重新打开。</p>}
      {error && (
        <p className="error-inline" role="alert">
          {error}
        </p>
      )}
      {succeeded && successMessage && (
        <p className="hint" role="status">
          {successMessage}
        </p>
      )}
      <div className="form-actions">
        <button className={"button" + (primary ? " primary" : "")} disabled={pending || busy}>
          {pending ? "正在保存…" : label}
        </button>
      </div>
    </form>
  );
}
