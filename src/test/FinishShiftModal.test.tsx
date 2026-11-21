// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FinishShiftModal } from '../client/components/FinishShiftModal';

describe('FinishShiftModal — restricción obligatoria de confirmación', () => {
  it('enfoca Cancelar por defecto, no cierra al pulsar fuera y avisa si está en pausa', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    render(
      <FinishShiftModal
        open={true}
        shiftStartUtc="2026-11-21T08:00:00.000Z"
        effectiveMs={3 * 60 * 60 * 1000}
        breakMs={20 * 60 * 1000}
        breaks={[
          {
            id: 'b1',
            startUtc: '2026-11-21T10:00:00.000Z',
            endUtc: null,
            durationMs: 20 * 60 * 1000,
            breakTypeName: 'Descanso reglamentario',
            isOpen: true,
          },
        ]}
        isOnBreak={true}
        submitting={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    const cancelButton = screen.getByRole('button', { name: 'Cancelar' });
    const confirmButton = screen.getByRole('button', { name: 'Sí, finalizar jornada' });

    // El foco por defecto debe estar en Cancelar
    expect(document.activeElement).toBe(cancelButton);

    // Debe advertir que la pausa activa se cerrará al finalizar
    expect(screen.getByText(/la pausa activa se cerrará automáticamente/i)).toBeInTheDocument();

    // Tocar el fondo exterior (backdrop) NO debe cerrar el modal ni confirmar
    const backdrop = screen.getByTestId('finish-shift-backdrop');
    fireEvent.click(backdrop);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();

    // Solo al pulsar "Sí, finalizar jornada" se confirma
    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
