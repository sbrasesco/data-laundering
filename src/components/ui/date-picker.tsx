import { useState } from "react"
import { format, parse, isValid } from "date-fns"
import { es } from "date-fns/locale"
import { Calendar as CalendarIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

interface DatePickerProps {
  /** Valor en formato yyyy-MM-dd ('' = sin fecha) — mismo contrato que <input type="date"> */
  value: string
  /** Devuelve yyyy-MM-dd, o '' al limpiar */
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}

/**
 * DatePicker shadcn (Popover + Calendar de react-day-picker, locale es).
 * Reemplazo drop-in de <Input type="date">: mismo contrato de valor (yyyy-MM-dd / '').
 */
export function DatePicker({ value, onChange, placeholder = "Elegir fecha", className }: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const parsed = value ? parse(value, "yyyy-MM-dd", new Date()) : undefined
  const selected = parsed && isValid(parsed) ? parsed : undefined

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            "justify-start text-left font-normal",
            !selected && "text-muted-foreground",
            className
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
          {selected ? format(selected, "dd/MM/yyyy", { locale: es }) : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          locale={es}
          selected={selected}
          defaultMonth={selected}
          onSelect={(d) => {
            onChange(d ? format(d, "yyyy-MM-dd") : "")
            setOpen(false)
          }}
        />
        {selected && (
          <div className="border-t p-2 text-right">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => { onChange(""); setOpen(false) }}
            >
              Limpiar
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
