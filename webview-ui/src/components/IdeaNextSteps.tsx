export function IdeaNextSteps() {
  return (
    <section aria-label="Qué pasa ahora" className="flex flex-col gap-8">
      <h3>Qué pasa ahora</h3>
      <p>Guardar no inicia ningún trabajo. Tú decides cuándo ejecutar el comando.</p>
      <ol className="list-decimal pl-24">
        <li>
          Investigación previa opcional: se pide por separado con «research run --idea»; el flujo
          usa su informe si existe.
        </li>
        <li>
          Requisitos: se prepara la especificación y las preguntas aparecen en Decisiones para que
          respondas y apruebes.
        </li>
        <li>Plan técnico: puedes revisarlo en Features y aprobarlo tú con «Aprobar plan».</li>
        <li>Desarrollo: se implementan las tareas del plan.</li>
        <li>
          Revisión y QA: se revisa el trabajo y se comprueban los criterios; la integración final
          requiere intervención humana.
        </li>
        <li>
          Investigación posterior: puedes pedirla por separado con «research review» cuando el
          trabajo esté listo para integrar; contrasta lo construido con el plan.
        </li>
      </ol>
      <p>
        Cada etapa que necesita una decisión humana espera por ti. Resuelve lo pendiente y vuelve a
        ejecutar el comando para continuar.
      </p>
      <p>
        Ejecutar consume cuota de tus modelos. Los costes mostrados son estimaciones, no cargos; la
        investigación pide confirmar su estimación y tope antes de empezar.
      </p>
    </section>
  );
}
