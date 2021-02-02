import { ForbiddenError } from 'apollo-server'
import { wrap } from '../util'
import SystemCore from '../../core/system'

const SystemResolvers = {
  Query: {
    'system': wrap((_, args, { indexDynamo }) => {
      return SystemCore(indexDynamo.system, indexDynamo.transactions('system'))
    })
  },
  'Mutation': {
    'admin': wrap((_, args, { indexDynamo, admin }) => {
      if (!admin) {
        throw new ForbiddenError('Access denied')
      }
      return SystemCore(indexDynamo.system, indexDynamo.transactions('system'))
    })
  },
  'System': {
    'register': wrap(async (SystemCore, { registration }, { indexDynamo }) => {
      return SystemCore.register(registration)
    }),
    'parameters': wrap(async (SystemCore, args, { indexDynamo }) => {
      return indexDynamo.system.parameters()
    }),
    'challenge': wrap(async (SystemCore) => {
      return SystemCore.challenge()
    }),
    'findkey': wrap(async (SystemCore, { id }, { indexDynamo }) => {
      return indexDynamo.findkey(id)
    })
  },
  'Admin': {
    'init': wrap(async (SystemCore, noargs, { admin }) => {
      return SystemCore.init()
    }),
    'jubilee': wrap(async (SystemCore, noargs, { userpool, admin }) => {
      // TODO
      return {}
    })
  }
}

export { SystemResolvers }
