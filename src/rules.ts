import * as Yup from 'yup'
import {
  IRuleFunction,
  IRule,
  IRuleOptions,
  ICache,
  IFragment,
  ICacheContructorOptions,
  IRuleConstructorOptions,
  ILogicRule,
  ShieldRule,
  IRuleResult,
  IOptions,
  IShieldContext,
} from './types'
import { isLogicRule } from './utils'
import { GraphQLResolveInfo } from 'graphql'

export class Rule implements IRule {
  readonly name: string

  private cache: ICache
  private fragment?: IFragment
  private func: IRuleFunction

  constructor(
    name: string,
    func: IRuleFunction,
    constructorOptions: IRuleConstructorOptions,
  ) {
    const options = this.normalizeOptions(constructorOptions)

    this.name = name
    this.func = func
    this.cache = options.cache
    this.fragment = options.fragment
  }

  /**
   *
   * @param parent
   * @param args
   * @param ctx
   * @param info
   *
   * Resolves rule and writes to cache its result.
   *
   */
  async resolve(
    parent: object,
    args: object,
    ctx: IShieldContext,
    info: GraphQLResolveInfo,
    options: IOptions,
  ): Promise<IRuleResult> {
    try {
      /* Resolve */
      const res = await this.executeRule(parent, args, ctx, info, options)

      if (res instanceof Error) {
        return res
      } else if (typeof res === 'string') {
        return new Error(res)
      } else if (res === true) {
        return true
      } else {
        return false
      }
    } catch (err) {
      if (options.debug) {
        throw err
      } else {
        return false
      }
    }
  }

  /**
   *
   * @param rule
   *
   * Compares a given rule with the current one
   * and checks whether their functions are equal.
   *
   */
  equals(rule: Rule): boolean {
    return this.func === rule.func
  }

  /**
   *
   * Extracts fragment from the rule.
   *
   */
  extractFragment(): IFragment | undefined {
    return this.fragment
  }

  /**
   *
   * @param options
   *
   * Sets default values for options.
   *
   */
  private normalizeOptions(options: IRuleConstructorOptions): IRuleOptions {
    return {
      cache:
        options.cache !== undefined
          ? this.normalizeCacheOption(options.cache)
          : 'no_cache',
      fragment: options.fragment !== undefined ? options.fragment : undefined,
    }
  }

  /**
   *
   * @param cache
   *
   * This ensures backward capability of shield.
   *
   */
  private normalizeCacheOption(cache: ICacheContructorOptions): ICache {
    switch (cache) {
      case true: {
        return 'strict'
      }
      case false: {
        return 'no_cache'
      }
      default: {
        return cache
      }
    }
  }

  /**
   * Executes a rule and writes to cache if needed.
   *
   * @param parent
   * @param args
   * @param ctx
   * @param info
   */
  private executeRule(
    parent: object,
    args: object,
    ctx: IShieldContext,
    info: GraphQLResolveInfo,
    options: IOptions,
  ): string | boolean | Error | Promise<IRuleResult> {
    switch (typeof this.cache) {
      case 'function': {
        /* User defined cache function. */
        const key = `${this.name}-${this.cache(parent, args, ctx, info)}`
        return this.writeToCache(key)(parent, args, ctx, info)
      }
      case 'string': {
        /* Standard cache option. */
        switch (this.cache) {
          case 'strict': {
            const key = options.hashFunction({ parent, args })

            return this.writeToCache(`${this.name}-${key}`)(
              parent,
              args,
              ctx,
              info,
            )
          }
          case 'contextual': {
            return this.writeToCache(this.name)(parent, args, ctx, info)
          }
          case 'no_cache': {
            return this.func(parent, args, ctx, info)
          }
        }
      }
      /* istanbul ignore next */
      default: {
        throw new Error(`Unsupported cache format: ${typeof this.cache}`)
      }
    }
  }

  /**
   * Writes or reads result from cache.
   *
   * @param key
   */

  private writeToCache(
    key: string,
  ): (
    parent: object,
    args: object,
    ctx: IShieldContext,
    info: GraphQLResolveInfo,
  ) => string | boolean | Error | Promise<IRuleResult> {
    return (parent, args, ctx, info) => {
      if (!ctx._shield.cache[key]) {
        return (ctx._shield.cache[key] = this.func(parent, args, ctx, info))
      }
      return ctx._shield.cache[key]
    }
  }
}

export class InputRule<Schema> extends Rule {
  constructor(name: string, schema: Yup.Schema<Schema>) {
    const validationFunction = (parent: object, args: object) =>
      schema
        .validate(args)
        .then(() => true)
        .catch(err => err)

    super(name, validationFunction, { cache: 'strict', fragment: undefined })
  }
}

export class LogicRule implements ILogicRule {
  private rules: ShieldRule[]

  constructor(rules: ShieldRule[]) {
    this.rules = rules
  }

  /**
   *
   * @param parent
   * @param args
   * @param ctx
   * @param info
   *
   * By default logic rule resolves to false.
   *
   */
  async resolve(
    parent: object,
    args: object,
    ctx: IShieldContext,
    info: GraphQLResolveInfo,
    options: IOptions,
  ): Promise<IRuleResult> {
    return false
  }

  /**
   *
   * @param parent
   * @param args
   * @param ctx
   * @param info
   *
   * Evaluates all the rules.
   *
   */
  async evaluate(
    parent: object,
    args: object,
    ctx: IShieldContext,
    info: GraphQLResolveInfo,
    options: IOptions,
  ): Promise<IRuleResult[]> {
    const rules = this.getRules()
    const tasks = rules.map(rule =>
      rule.resolve(parent, args, ctx, info, options),
    )

    return Promise.all(tasks)
  }

  /**
   *
   * Returns rules in a logic rule.
   *
   */
  getRules() {
    return this.rules
  }

  extractFragments(): IFragment[] {
    const fragments = this.rules.reduce<IFragment[]>((fragments, rule) => {
      if (isLogicRule(rule)) {
        return fragments.concat(...rule.extractFragments())
      }

      const fragment = rule.extractFragment()
      if (fragment) return fragments.concat(fragment)

      return fragments
    }, [])

    return fragments
  }
}

// Extended Types

export class RuleOr extends LogicRule {
  constructor(rules: ShieldRule[]) {
    super(rules)
  }

  /**
   *
   * @param parent
   * @param args
   * @param ctx
   * @param info
   *
   * Makes sure that at least one of them has evaluated to true.
   *
   */
  async resolve(
    parent: object,
    args: object,
    ctx: IShieldContext,
    info: GraphQLResolveInfo,
    options: IOptions,
  ): Promise<IRuleResult> {
    const result = await this.evaluate(parent, args, ctx, info, options)

    if (result.every(res => res !== true)) {
      const customError = result.find(res => res instanceof Error)
      return customError || false
    } else {
      return true
    }
  }
}

export class RuleAnd extends LogicRule {
  constructor(rules: ShieldRule[]) {
    super(rules)
  }

  /**
   *
   * @param parent
   * @param args
   * @param ctx
   * @param info
   *
   * Makes sure that all of them have resolved to true.
   *
   */
  async resolve(
    parent: object,
    args: object,
    ctx: IShieldContext,
    info: GraphQLResolveInfo,
    options: IOptions,
  ): Promise<IRuleResult> {
    const result = await this.evaluate(parent, args, ctx, info, options)

    if (result.some(res => res !== true)) {
      const customError = result.find(res => res instanceof Error)
      return customError || false
    } else {
      return true
    }
  }
}

export class RuleChain extends LogicRule {
  constructor(rules: ShieldRule[]) {
    super(rules)
  }

  /**
   *
   * @param parent
   * @param args
   * @param ctx
   * @param info
   *
   * Makes sure that all of them have resolved to true.
   *
   */
  async resolve(
    parent: object,
    args: object,
    ctx: IShieldContext,
    info: GraphQLResolveInfo,
    options: IOptions,
  ): Promise<IRuleResult> {
    const result = await this.evaluate(parent, args, ctx, info, options)

    if (result.some(res => res !== true)) {
      const customError = result.find(res => res instanceof Error)
      return customError || false
    } else {
      return true
    }
  }

  /**
   *
   * @param parent
   * @param args
   * @param ctx
   * @param info
   *
   * Evaluates all the rules.
   *
   */
  async evaluate(
    parent: object,
    args: object,
    ctx: IShieldContext,
    info: GraphQLResolveInfo,
    options: IOptions,
  ): Promise<IRuleResult[]> {
    const rules = this.getRules()
    const tasks = rules.reduce<Promise<IRuleResult[]>>(
      (acc, rule) =>
        acc.then(res => {
          if (res.some(r => r !== true)) {
            return res
          } else {
            return rule
              .resolve(parent, args, ctx, info, options)
              .then(task => res.concat(task))
          }
        }),
      Promise.resolve([]),
    )

    return tasks
  }
}

export class RuleNot extends LogicRule {
  constructor(rule: ShieldRule) {
    super([rule])
  }

  /**
   *
   * @param parent
   * @param args
   * @param ctx
   * @param info
   *
   * Negates the result.
   *
   */
  async resolve(
    parent: object,
    args: object,
    ctx: IShieldContext,
    info: GraphQLResolveInfo,
    options: IOptions,
  ): Promise<IRuleResult> {
    const [res] = await this.evaluate(parent, args, ctx, info, options)

    if (res !== true) {
      return true
    } else {
      return false
    }
  }
}

export class RuleTrue extends LogicRule {
  constructor() {
    super([])
  }

  /**
   *
   * Always true.
   *
   */
  async resolve(): Promise<IRuleResult> {
    return true
  }
}

export class RuleFalse extends LogicRule {
  constructor() {
    super([])
  }

  /**
   *
   * Always false.
   *
   */
  async resolve(): Promise<IRuleResult> {
    return false
  }
}
