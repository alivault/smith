import * as React from "react"
import { ChevronDownIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

/**
 * Model Selector, the AI Elements pattern
 * (https://ui.shadcn.com/docs/ai-elements/base/model-selector): small menus
 * below the prompt that pick the model and how hard it thinks. Smith's model
 * list is long and searchable, so the model button opens a dialog;
 * `ModelSelectorButton` gives it the same look as the menu triggers.
 */
function ModelSelectorButton({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className={cn(
        "min-w-0 cursor-pointer text-muted-foreground hover:text-foreground",
        className
      )}
      {...props}
    >
      <span className="truncate">{children}</span>
      <ChevronDownIcon data-icon="inline-end" />
    </Button>
  )
}

const ModelSelector = DropdownMenu

/** The trigger of a selector menu, as a `ModelSelectorButton`. */
function ModelSelectorTrigger({
  children,
  className,
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <DropdownMenuTrigger
      render={<ModelSelectorButton className={className} {...props} />}
    >
      {children}
    </DropdownMenuTrigger>
  )
}

/** The menu, with a heading and one item to choose. */
function ModelSelectorContent<Value extends string>({
  className,
  label,
  onValueChange,
  options,
  value,
}: {
  className?: string
  label: string
  onValueChange: (value: Value) => void
  options: Array<{ value: Value; label: React.ReactNode }>
  value: Value
}) {
  return (
    <DropdownMenuContent side="top" align="start" className={className}>
      <DropdownMenuGroup>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next: Value) => onValueChange(next)}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              closeOnClick
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  )
}

export {
  ModelSelector,
  ModelSelectorButton,
  ModelSelectorContent,
  ModelSelectorTrigger,
}
