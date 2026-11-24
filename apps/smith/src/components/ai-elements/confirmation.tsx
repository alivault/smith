import * as React from "react"

import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { cn } from "@/lib/utils"

/**
 * Confirmation, the AI Elements pattern
 * (https://ui.shadcn.com/docs/ai-elements/base/confirmation): a yes or no
 * question as an outlined Item, with its answer buttons at the end.
 */
function Confirmation({
  actions,
  className,
  icon,
  title,
}: {
  actions: React.ReactNode
  className?: string
  icon?: React.ReactNode
  title: React.ReactNode
}) {
  return (
    <Item
      variant="outline"
      size="sm"
      data-slot="confirmation"
      className={cn("bg-background/60", className)}
    >
      {icon ? <ItemMedia variant="icon">{icon}</ItemMedia> : null}
      <ItemContent className="min-w-48">
        <ItemTitle className="block w-full font-normal">{title}</ItemTitle>
      </ItemContent>
      <ItemActions>{actions}</ItemActions>
    </Item>
  )
}

export { Confirmation }
