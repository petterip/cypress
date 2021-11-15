import 'cypress-real-events/support'
// @ts-ignore
import installCustomPercyCommand from '@packages/ui-components/cypress/support/customPercyCommand'

installCustomPercyCommand({
  before () {
    cy.get('.stats').should('be.visible')
  },
  elementOverrides: {
    '.command-progress': true,
    '.cy-tooltip': true,
  },
})
