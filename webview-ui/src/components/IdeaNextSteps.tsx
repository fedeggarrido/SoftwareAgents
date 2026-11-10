export function IdeaNextSteps() {
  return (
    <section aria-label="Qué pasa ahora" className="flex flex-col gap-8">
      <h3>Qué pasa ahora</h3>
      <p>Guardar no inicia ningún trabajo. Tú decides cuándo continuar.</p>
      <ol className="list-decimal pl-24">
        <li>
          Investigación previa opcional: se pide por separado; el flujo usa su informe si existe.
        </li>
        <li>
          Requisitos: se prepara la especificación. Si tiene dudas, las ves en el panel de
          Decisiones. Después respondes y apruebas la especificación; sin esa aprobación el flujo no
          avanza.
        </li>
        <li>
          Plan técnico: se genera el diseño y las tareas. Puedes revisarlo en Features y marcarlo
          con «Aprobar plan», pero hoy el desarrollo no espera a esa aprobación.
        </li>
        <li>Desarrollo: se implementan las tareas del plan.</li>
        <li>
          Revisión y QA: se revisa el trabajo y se comprueban los criterios; la integración final
          requiere intervención humana.
        </li>
        <li>
          Investigación posterior: puedes pedirla por separado cuando el trabajo esté listo para
          integrar; contrasta lo construido con el plan.
        </li>
      </ol>
      <p>
        Cada etapa que necesita una decisión humana espera por ti. Resuelve lo pendiente para
        continuar.
      </p>
      <details>
        <summary>Detalles</summary>
        <p>
          Para investigar antes, usa «research run --idea». Responde las dudas en un archivo
          Markdown con «feature spec &lt;id&gt; --answers &lt;archivo&gt;» y aprueba con «feature
          approve &lt;id&gt;». Vuelve a ejecutar el comando de continuación cuando resuelvas lo
          pendiente. La investigación posterior se pide con «research review».
        </p>
      </details>
      <p>
        Ejecutar consume cuota de tus modelos. Los costes mostrados son estimaciones, no cargos; la
        investigación pide confirmar su estimación y tope antes de empezar.
      </p>
    </section>
  );
}
