# 🚀 SPRINTS — Sistema GeoEsforço

---

# 🏁 SPRINT 0 — Definição do modelo de esforço e contrato de cálculo

**Status:** Não feito / feito  
**Persona:** Especialista em produção cartográfica + desenvolvedor backend  

## Contexto
Antes de qualquer implementação, é necessário garantir que o modelo de cálculo de esforço representa corretamente o processo real de produção de cartas topográficas.

O principal risco é modelar incorretamente o esforço (ex: considerar área como área, quando operacionalmente vira linha + ponto).

## Tarefa
Definir formalmente o modelo de esforço:

- Mapear **camadas EDGV → subfases (N:N)**  
- Definir **tipo de métrica por camada**:
  - km (linhas)
  - quantidade (pontos)
  - km² (áreas)
- Definir regras de **conversão geométrica**
- Definir pesos (**camada + subfase**)
- Definir fórmula oficial de cálculo

## Critérios de aceite
- Documento/JSON com modelo completo
- Cálculo explicável manualmente
- Coerente com realidade operacional

---

# 🏁 SPRINT 1 — Prova de conceito com dados reais

**Status:** Não feito / feito  
**Persona:** Desenvolvedor com acesso ao PostGIS  

## Contexto
Validar o modelo antes de construir sistema completo.

## Tarefa
- Criar query de métricas (km, qtd, área)
- Aplicar conversões
- Aplicar pesos
- Calcular score de 3 UTs

## Critérios de aceite
- Score por UT calculado
- Resultado coerente
- Output estruturado (JSON/tabela)

---

# 🏁 SPRINT 2 — Motor de cálculo reutilizável

**Status:** Não feito / feito  
**Persona:** Desenvolvedor Node.js  

## Contexto
Encapsular lógica em um motor reutilizável.

## Tarefa
Implementar:

- extractMetrics(ut_id)
- convertMetrics(metrics)
- calculateScore(ut_id)

Fluxo obrigatório:
subfase → camada → métrica → peso

## Critérios de aceite
- Retorna score total
- Retorna breakdown por subfase e camada
- Resultado consistente com Sprint 1

---

# 🏁 SPRINT 3 — Persistência e versionamento

**Status:** Não feito / feito  
**Persona:** Backend / arquiteto de dados  

## Contexto
Sistema precisa ser auditável.

## Tarefa
- Criar tabela score_ut
- Versionar pesos
- Armazenar histórico de cálculo

## Critérios de aceite
- Histórico preservado
- Comparação entre versões possível
- Rastreabilidade garantida

---

# 🏁 SPRINT 4 — Integração com produção real

**Status:** Não feito / feito  
**Persona:** Backend + gestor  

## Contexto
Comparar teoria vs realidade.

## Tarefa
- Criar producao_real
- Registrar operador, subfase, tempo
- Relacionar com UT

## Critérios de aceite
- Consulta de tempo por UT
- Consulta por subfase
- Dados consistentes

---

# 🏁 SPRINT 5 — Análise e eficiência

**Status:** Não feito / feito  
**Persona:** Analista / backend  

## Contexto
Gerar inteligência do sistema.

## Tarefa
- Calcular eficiência:
  tempo_real / score
- Detectar desvios
- Relatórios por camada/subfase

## Critérios de aceite
- Eficiência calculada
- Distorções identificáveis
- Resultados interpretáveis

---

# 🏁 SPRINT 6 — Distribuição de carga

**Status:** Não feito / feito  
**Persona:** Backend + operação  

## Contexto
Resolver distribuição de trabalho.

## Tarefa
- Ordenar UTs por score
- Distribuir entre operadores
- Balancear carga

## Critérios de aceite
- Carga equilibrada
- Diferença mínima entre operadores
- Simulação funcional

---

# 🏁 SPRINT 7 — API

**Status:** Não feito / feito  
**Persona:** Backend  

## Contexto
Expor sistema para uso externo.

## Tarefa
Criar endpoints:

- GET /ut/:id/score  
- GET /ut/:id/eficiencia  
- GET /distribuicao  

## Critérios de aceite
- API funcional
- Respostas consistentes
- Documentação básica

---

# 🏁 SPRINT 8 — Calibração automática

**Status:** Não feito / feito  
**Persona:** Backend / dados  

## Contexto
Evolução contínua do modelo.

## Tarefa
- Ajustar pesos com base em histórico
- Detectar desvios
- Sugerir novos pesos

## Critérios de aceite
- Sugestões de ajuste funcionando
- Redução de erro entre teórico e real
- Consistência mantida

---

# 🧠 Observação Final

- Não pular Sprint 0 e 1  
- Validar com dados reais antes de escalar  
- O modelo é mais importante que o código  
