// Copyright 2012 Traceur Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {
  BindingElement,
  BindingIdentifier,
  EmptyStatement,
  LiteralPropertyName,
  ObjectPattern,
  ObjectPatternField,
  Script
} from '../syntax/trees/ParseTrees';
import {TempVarTransformer} from './TempVarTransformer';
import {
  EXPORT_SPECIFIER,
  EXPORT_STAR,
  MODULE,
  SCRIPT
} from '../syntax/trees/ParseTreeType';
import {
  STAR,
  VAR
} from '../syntax/TokenType';
import {assert} from '../util/assert';
import {
  createBindingIdentifier,
  createIdentifierExpression,
  createMemberExpression,
  createObjectLiteralExpression,
  createUseStrictDirective,
  createVariableStatement
} from './ParseTreeFactory';
import {
  parseExpression,
  parsePropertyDefinition,
  parseStatement
} from './PlaceholderParser';

/**
 * This creates the code that defines the getter for an export.
 * @param {ModuleTransformer} transformer
 * @param {ExportSymbol} symbol
 * @return {ParseTree}
 */
function getGetterExport(transformer, symbol) {
  // NAME: {get: function() { return <returnExpression> },
  var name = symbol.name;
  var tree = symbol.tree;
  var returnExpression;
  switch (tree.type) {
    case EXPORT_SPECIFIER:
      var moduleSpecifier = symbol.relatedTree;
      if (moduleSpecifier) {
        var idName =
            transformer.getTempVarNameForModuleSpecifier(moduleSpecifier);
        returnExpression = createMemberExpression(idName, tree.lhs);
      } else {
        returnExpression = createIdentifierExpression(tree.lhs)
      }
      break;

    case EXPORT_STAR:
      assert(symbol.relatedTree);
      var moduleSpecifier = symbol.relatedTree;
      var idName =
          transformer.getTempVarNameForModuleSpecifier(moduleSpecifier);
      returnExpression = createMemberExpression(idName, symbol.name);
      break;

    default:
      returnExpression = createIdentifierExpression(name);
      break;
  }

  return parsePropertyDefinition
      `${name}: {
         get: function() { return ${returnExpression}; },
         enumerable: true
       }`;
}

export class ModuleTransformer extends TempVarTransformer {
  /**
   * @param {Project} project
   */
  constructor(project, module = null) {
    super(project.identifierGenerator);
    this.project = project;
    this.module = module;
    this.idMappingStack_ = [Object.create(null)];
  }

  get url() {
    if (this.module)
      return this.module.url;
    return this.project.url;
  }

  getTempVarNameForModuleSpecifier(moduleSpecifier) {
    var moduleName = moduleSpecifier.token.processedValue;
    var idMapping = this.idMappingStack_[this.idMappingStack_.length - 1]
    var id = idMapping[moduleName];
    return id || (idMapping[moduleName] = this.getTempIdentifier());
  }

  pushTempVarState() {
    super.pushTempVarState();
    this.idMappingStack_.push(Object.create(null));
  }

  popTempVarState() {
    super.popTempVarState();
    this.idMappingStack_.pop();
  }

  transformModule(tree) {
    assert(this.url);

    this.pushTempVarState();

    var statements = [
      createUseStrictDirective(),
      ...this.transformList(tree.scriptItemList),
      this.createExportStatement()
    ];

    this.popTempVarState();

    var registerStatement = parseStatement
        `System.get('@traceur/module').registerModule(${this.url}, function() {
          ${statements}
        }, this);`;

    return new Script(tree.location, [registerStatement]);
  }

  createExportStatement() {
    var properties = this.module.getExports().map((exp) => {
      // export_name: {get: function() { return export_name },
      return getGetterExport(this, exp);
    });
    var descriptors = createObjectLiteralExpression(properties);
    return parseStatement
        `return Object.preventExtensions(Object.create(null, ${descriptors}));`;
  }

  transformExportDeclaration(tree) {
    return this.transformAny(tree.declaration);
  }

  transformNamedExport(tree) {
    var moduleSpecifier = tree.moduleSpecifier;
    if (moduleSpecifier) {
      var expression = this.transformAny(moduleSpecifier);
      var idName = this.getTempVarNameForModuleSpecifier(moduleSpecifier);
      return createVariableStatement(VAR, idName, expression);
    }
    return new EmptyStatement(null);
  }

  /**
   * @param {ModuleSpecifier} tree
   * @return {ParseTree}
   */
  transformModuleSpecifier(tree) {
    var token = tree.token;
    return parseExpression `System.get(${token})`;
  }

  /**
   * @param {ModuleDeclaration} tree
   * @return {VariableDeclaration}
   */
  transformModuleDeclaration(tree) {
    var initializer = this.transformAny(tree.expression);
    // const a = b.c, d = e.f;
    // TODO(arv): const is not allowed in ES5 strict
    return createVariableStatement(VAR, tree.identifier, initializer);
  }

  transformImportDeclaration(tree) {
    // import {id} from 'module';
    //  =>
    // var {id} = moduleInstance
    var binding = this.transformAny(tree.importSpecifierSet);
    var initializer = this.transformAny(tree.moduleSpecifier);

    return createVariableStatement(VAR, binding, initializer);
  }

  transformImportSpecifierSet(tree) {
    var fields;
    if (tree.specifiers.type === STAR) {
      var module = this.project.getModuleForStarTree(tree);
      var fields = module.getExports().map((exportSymbol) => {
        return new BindingElement(tree.location,
            createBindingIdentifier(exportSymbol.name), null);
      });
    } else {
      fields = this.transformList(tree.specifiers);
    }
    return new ObjectPattern(null, fields);
  }

  transformImportSpecifier(tree) {
    if (tree.rhs) {
      var binding = new BindingIdentifier(tree.location, tree.rhs);
      var bindingElement = new BindingElement(tree.location, binding, null);
      var name = new LiteralPropertyName(tree.lhs.location, tree.lhs);
      return new ObjectPatternField(tree.location, name, bindingElement);
    }
    return new BindingElement(tree.location,
        createBindingIdentifier(tree.lhs), null);
  }

  /**
   * @param {Project} project
   * @param {Script} tree
   * @return {Script}
   */
  static transform(project, tree) {
    assert(tree.type === SCRIPT);
    return new ModuleTransformer(project).transformAny(tree);
  }

  /**
   * @param {Project} project
   * @param {Module} module
   * @param {Script} tree
   * @return {Script}
   */
  static transformAsModule(project, module, tree) {
    assert(tree.type === MODULE);
    assert(module);
    return new ModuleTransformer(project, module).transformAny(tree);
  }
}
