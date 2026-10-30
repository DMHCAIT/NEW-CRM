"use client";

import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

type DropdownOption = { value: string; label: string; disabled?: boolean };
type SharedProps = {
  id?: string;
  name?: string;
  options: DropdownOption[];
  placeholder: string;
  ariaLabel: string;
  className?: string;
  triggerClassName?: string;
  disabled?: boolean;
  required?: boolean;
  openDirection?: "auto" | "down";
  optionsMaxHeight?: number;
};
type SingleSelectProps = SharedProps & {
  multiple?: false;
  value: string;
  onChange: (value: string) => void;
};
type MultiSelectProps = SharedProps & {
  multiple: true;
  value: string[];
  onChange: (value: string[]) => void;
};

export function SearchableDropdown(props: SingleSelectProps | MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number } | null>(null);
  const listboxId = useId();
  const selectedValues = props.multiple ? props.value : props.value ? [props.value] : [];
  const selectedLabels = props.options
    .filter((option) => selectedValues.includes(option.value))
    .map((option) => option.label);
  const triggerLabel = props.multiple
    ? selectedLabels.length ? selectedLabels.join(", ") : props.placeholder
    : selectedLabels[0] ?? props.placeholder;
  const filteredOptions = [...props.options]
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }))
    .filter((option) => option.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));

  useLayoutEffect(() => {
    if (!open) return;
    function updatePosition() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const openAbove = props.openDirection === "auto" && below < 224 && above > below;
      const width = Math.min(Math.max(rect.width, 216), window.innerWidth - 16);
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        ...(openAbove ? { bottom: window.innerHeight - rect.top + 5 } : { top: rect.bottom + 5 }),
        width,
        maxHeight: Math.max(0, openAbove ? above : below),
      });
    }
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, props.openDirection]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node) && !panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  function toggleOpen() {
    setOpen((current) => !current);
    setSearch("");
  }

  function closeAndRestoreFocus() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSearch("");
        setOpen(true);
      }
      return;
    }
    const fromSearch = event.target === searchRef.current;
    if (fromSearch && (event.key === "Home" || event.key === "End")) return;
    const options = Array.from(optionsRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (!options.length) return;
    event.preventDefault();
    const index = options.findIndex((option) => option === event.target);
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? options.length - 1
        : event.key === "ArrowDown" ? (index + 1) % options.length
          : index <= 0 ? options.length - 1 : index - 1;
    options[nextIndex].focus();
    options[nextIndex].scrollIntoView({ block: "nearest" });
  }

  function chooseOption(optionValue: string) {
    if (props.multiple) {
      const nextValues = selectedValues.includes(optionValue)
        ? selectedValues.filter((value) => value !== optionValue)
        : [...selectedValues, optionValue];
      props.onChange(nextValues);
      return;
    }
    props.onChange(optionValue);
    closeAndRestoreFocus();
    setSearch("");
  }

  return (
    <div
      className={`searchable-dropdown ${props.className ?? ""}`}
      ref={containerRef}
      onKeyDown={handleKeyDown}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !panelRef.current?.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        disabled={props.disabled}
        ref={triggerRef}
        id={props.id}
        className={`searchable-dropdown-trigger ${props.triggerClassName ?? ""}`}
        aria-label={props.ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-describedby={props.required ? `${listboxId}-required` : undefined}
        aria-controls={open ? listboxId : undefined}
        onClick={toggleOpen}
        title={triggerLabel}
      >
        <span className={selectedValues.length ? "" : "searchable-dropdown-placeholder"}>{triggerLabel}</span>
        {props.required && <span id={`${listboxId}-required`} className="visually-hidden">Required</span>}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {(props.name || props.required) && !props.multiple && <input className="searchable-dropdown-validation" name={props.name} tabIndex={-1} aria-hidden="true" required={props.required} value={selectedValues[0] ?? ""} onChange={() => {}} onInvalid={(event) => {
        event.preventDefault();
        triggerRef.current?.focus();
        setOpen(true);
      }} />}
      {open && createPortal(
        <div
          ref={panelRef}
          className="searchable-dropdown searchable-dropdown-floating"
          style={{ ...position, visibility: position ? "visible" : "hidden" }}
        >
        <div className="searchable-dropdown-panel">
          <label className="searchable-dropdown-search">
            <Search size={14} aria-hidden="true" />
            <span className="visually-hidden">Search {props.ariaLabel.toLocaleLowerCase()}</span>
            <input
              ref={searchRef}
              type="search"
              value={search}
              placeholder="Search..."
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  const firstOption = filteredOptions.find((option) => !option.disabled);
                  if (firstOption) chooseOption(firstOption.value);
                }
              }}
            />
          </label>
          <div ref={optionsRef} className="searchable-dropdown-options" style={props.optionsMaxHeight ? { maxHeight: props.optionsMaxHeight } : undefined} id={listboxId} role="listbox" aria-label={props.ariaLabel} aria-multiselectable={props.multiple || undefined}>
            {filteredOptions.map((option) => {
              const selected = selectedValues.includes(option.value);
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-disabled={option.disabled || undefined}
                  disabled={option.disabled}
                  className={`searchable-dropdown-option ${selected ? "selected" : ""}`}
                  key={option.value}
                  title={option.label}
                  onClick={() => chooseOption(option.value)}
                >
                  <span>{option.label}</span>
                  {selected && <Check size={14} aria-hidden="true" />}
                </button>
              );
            })}
            {filteredOptions.length === 0 && <div className="searchable-dropdown-empty">No matching options</div>}
          </div>
        </div>
        </div>,
        containerRef.current?.closest("dialog") ?? document.body,
      )}
    </div>
  );
}
