import { useState } from 'react'

export function OnboardingModule() {
  const [checklist, setChecklist] = useState([
    { id: '1', title: 'Infraestrutura de Banco e Migrations', done: true, desc: 'PostgreSQL transacional e tabelas de custódia inicializadas.' },
    { id: '2', title: 'Unidade e Depósito Piloto Cadastrados', done: true, desc: 'Depósito Piloto - Sala 01 ativo para recebimento.' },
    { id: '3', title: 'Catálogo de Modelos Homologados', done: true, desc: 'Modelos Huawei, Intelbras, ZTE e Fiberhome catalogados.' },
    { id: '4', title: 'Homologação do Leitor de Código de Barras HID', done: true, desc: 'Scanner testado na bancada de diagnóstico com sufixo Enter.' },
    { id: '5', title: 'Instalação do PWA Mobile nos Celulares dos Técnicos', done: false, desc: 'Técnicos adicionaram o aplicativo à tela inicial com suporte offline.' },
    { id: '6', title: 'Primeiro Termo de Quitação Emitido em Balcão', done: false, desc: 'Conferência física confirmada com impressão de comprovante digital.' },
  ])

  function toggle(id: string) {
    setChecklist((prev) =>
      prev.map((item) => (item.id === id ? { ...item, done: !item.done } : item))
    )
  }

  return (
    <div className="module-container">
      <div className="section-head">
        <div>
          <h2>Checklist de Onboarding e Central de Ajuda (Cap. 21)</h2>
          <p className="muted">
            Guia passo a passo para implantação da cadeia de custódia digital na operação da New Life e instruções de
            configuração de hardware.
          </p>
        </div>
      </div>

      <div className="desk-grid">
        <section className="card">
          <h3>Progresso da Implantação Operacional</h3>
          <p className="muted">Marque as etapas concluídas na sua filial:</p>

          <ul className="onboarding-checklist">
            {checklist.map((step) => (
              <li
                key={step.id}
                className={`onboarding-item ${step.done ? 'step-done' : ''}`}
                onClick={() => toggle(step.id)}
              >
                <input
                  type="checkbox"
                  checked={step.done}
                  onChange={() => toggle(step.id)}
                />
                <div className="step-content">
                  <strong>{step.title}</strong>
                  <p className="muted">{step.desc}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="card help-guide-card">
          <h3>Instruções de Configuração de Leitores HID (USB / Bluetooth)</h3>
          <div className="guide-content">
            <h4>1. Configuração do Sufixo (Terminador)</h4>
            <p>
              Para máxima produtividade no balcão, configure seu leitor (Zebra, Honeywell, Datalogic ou Elgin) para
              enviar o sufixo <code>Enter (CR)</code> após cada código lido. Isso dispensa o uso do mouse durante a
              conferência.
            </p>

            <h4>2. Modo de Leitura Contínua</h4>
            <p>
              Recomendamos o modo <em>Presentation Mode</em> (gatilho contínuo por sensor de aproximação) ou suporte fixo
              de bancada.
            </p>

            <h4>3. Celular do Técnico (Android e iPhone)</h4>
            <ul>
              <li>
                <strong>Android (Google Chrome):</strong> acesse o sistema e toque em <em>"Instalar Aplicativo"</em> na
                barra superior.
              </li>
              <li>
                <strong>iPhone (Safari iOS):</strong> toque no botão <em>Compartilhar</em> e escolha <em>"Adicionar à Tela
                de Início"</em>.
              </li>
              <li>
                <strong>Permissão de Câmera:</strong> autorize o acesso à câmera traseira quando solicitado para capturar
                as etiquetas.
              </li>
            </ul>
          </div>
        </section>
      </div>
    </div>
  )
}
