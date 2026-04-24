import { Test, TestingModule } from '@nestjs/testing';
import { MultiLangAstService } from './multi-lang-ast.service';

const treeSitterAvailable = (() => {
  try {
    require('tree-sitter');
    return true;
  } catch {
    return false;
  }
})();

const describeTreeSitter = treeSitterAvailable ? describe : describe.skip;

describe('MultiLangAstService', () => {
  let service: MultiLangAstService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MultiLangAstService],
    }).compile();
    service = module.get<MultiLangAstService>(MultiLangAstService);
    await service.onModuleInit();
  });

  // ── Python ────────────────────────────────────────────────────────────────

  describeTreeSitter('Python parsing', () => {
    const pythonCode = `
import os
from typing import List

class UserService:
    def create_user(self, name: str) -> dict:
        return {"name": name}

    def _private_method(self):
        pass

def standalone_function(x: int) -> int:
    return x * 2
`;

    it('parses Python file without error', () => {
      const result = service.parseFile('app/services.py', pythonCode, 'python');
      expect(result.parseError).toBe(false);
      expect(result.language).toBe('python');
    });

    it('extracts Python class symbols', () => {
      const result = service.parseFile('app/services.py', pythonCode, 'python');
      const cls = result.symbols.find((s) => s.name === 'UserService');
      expect(cls).toBeDefined();
      expect(cls?.kind).toBe('class');
    });

    it('extracts Python function symbols', () => {
      const result = service.parseFile('app/services.py', pythonCode, 'python');
      const fn = result.symbols.find((s) => s.name === 'create_user');
      expect(fn).toBeDefined();
      expect(fn?.kind).toBe('function');
    });

    it('extracts standalone Python function', () => {
      const result = service.parseFile('app/services.py', pythonCode, 'python');
      const fn = result.symbols.find((s) => s.name === 'standalone_function');
      expect(fn).toBeDefined();
    });

    it('extracts Python imports', () => {
      const result = service.parseFile('app/services.py', pythonCode, 'python');
      expect(result.imports.length).toBeGreaterThan(0);
    });

    it('handles empty Python file', () => {
      const result = service.parseFile('app/empty.py', '', 'python');
      expect(result.parseError).toBe(false);
      expect(result.symbols).toHaveLength(0);
    });
  });

  // ── Go ────────────────────────────────────────────────────────────────────

  describeTreeSitter('Go parsing', () => {
    const goCode = `
package main

import "fmt"

type UserRepository struct {
    db *Database
}

func (r *UserRepository) FindByID(id int) (*User, error) {
    return nil, nil
}

func NewUserRepository(db *Database) *UserRepository {
    return &UserRepository{db: db}
}
`;

    it('parses Go file without error', () => {
      const result = service.parseFile('cmd/repo.go', goCode, 'go');
      expect(result.parseError).toBe(false);
      expect(result.language).toBe('go');
    });

    it('extracts Go function symbols', () => {
      const result = service.parseFile('cmd/repo.go', goCode, 'go');
      const fn = result.symbols.find((s) => s.name === 'NewUserRepository');
      expect(fn).toBeDefined();
      expect(fn?.kind).toBe('function');
    });

    it('marks exported Go functions', () => {
      const result = service.parseFile('cmd/repo.go', goCode, 'go');
      const exported = result.symbols.find((s) => s.name === 'NewUserRepository');
      expect(exported?.exported).toBe(true);
    });

    it('extracts Go methods with receiver and parameters', () => {
      const result = service.parseFile('cmd/repo.go', goCode, 'go');
      const method = result.methods.find((m) => m.name === 'FindByID');
      expect(method).toBeDefined();
      expect(method?.className).toBe('UserRepository');
      expect(method?.parameters).toContain('id');
    });

    it('handles empty Go file', () => {
      const result = service.parseFile('cmd/empty.go', 'package main', 'go');
      expect(result.parseError).toBe(false);
    });
  });

  // ── Java ──────────────────────────────────────────────────────────────────

  describeTreeSitter('Java parsing', () => {
    const javaCode = `
package com.example;

import org.springframework.stereotype.Service;

@Service
public class UserService {
    public User findById(Long id) {
        return null;
    }

    private void internalMethod() {}
}
`;

    it('parses Java file without error', () => {
      const result = service.parseFile('UserService.java', javaCode, 'java');
      expect(result.parseError).toBe(false);
      expect(result.language).toBe('java');
    });

    it('extracts Java class symbols', () => {
      const result = service.parseFile('UserService.java', javaCode, 'java');
      const cls = result.symbols.find((s) => s.name === 'UserService');
      expect(cls).toBeDefined();
      expect(cls?.kind).toBe('class');
    });

    it('extracts Java annotations', () => {
      const result = service.parseFile('UserService.java', javaCode, 'java');
      const cls = result.symbols.find((s) => s.name === 'UserService');
      expect(cls?.decorators).toContain('Service');
    });

    it('extracts Java methods with class name and parameters', () => {
      const result = service.parseFile('UserService.java', javaCode, 'java');
      const method = result.methods.find((m) => m.name === 'findById');
      expect(method).toBeDefined();
      expect(method?.className).toBe('UserService');
      expect(method?.parameters).toContain('id');
    });

    it('handles empty Java file', () => {
      const result = service.parseFile('Empty.java', 'public class Empty {}', 'java');
      expect(result.parseError).toBe(false);
    });
  });

  // ── Kotlin ────────────────────────────────────────────────────────────────

  describeTreeSitter('Kotlin parsing', () => {
    const kotlinCode = `
package com.example

import org.springframework.stereotype.Service

@Service
class UserService {
    fun findById(id: Long): User? {
        return null
    }
}

data class User(val id: Long, val name: String)
`;

    it('parses Kotlin file without error', () => {
      const result = service.parseFile('UserService.kt', kotlinCode, 'kotlin');
      expect(result.parseError).toBe(false);
      expect(result.language).toBe('kotlin');
    });

    it('extracts Kotlin class symbols', () => {
      const result = service.parseFile('UserService.kt', kotlinCode, 'kotlin');
      const cls = result.symbols.find((s) => s.name === 'UserService');
      expect(cls).toBeDefined();
      expect(cls?.kind).toBe('class');
    });

    it('extracts Kotlin imports', () => {
      const result = service.parseFile('UserService.kt', kotlinCode, 'kotlin');
      expect(result.imports.length).toBeGreaterThan(0);
    });
  });

  // ── Rust ──────────────────────────────────────────────────────────────────

  describeTreeSitter('Rust parsing', () => {
    const rustCode = `
use std::collections::HashMap;

pub struct UserRepository {
    db: Database,
}

impl UserRepository {
    pub fn new(db: Database) -> Self {
        UserRepository { db }
    }
}

pub fn create_user(name: &str) -> User {
    User { name: name.to_string() }
}

fn private_helper() {}
`;

    it('parses Rust file without error', () => {
      const result = service.parseFile('src/repo.rs', rustCode, 'rust');
      expect(result.parseError).toBe(false);
      expect(result.language).toBe('rust');
    });

    it('extracts Rust struct symbol', () => {
      const result = service.parseFile('src/repo.rs', rustCode, 'rust');
      const struct = result.symbols.find((s) => s.name === 'UserRepository');
      expect(struct).toBeDefined();
      expect(struct?.kind).toBe('class');
    });

    it('marks public Rust items as exported', () => {
      const result = service.parseFile('src/repo.rs', rustCode, 'rust');
      const pub = result.symbols.find((s) => s.name === 'create_user');
      expect(pub?.exported).toBe(true);
    });

    it('extracts Rust methods and function parameters correctly', () => {
      const result = service.parseFile('src/repo.rs', rustCode, 'rust');
      const method = result.methods.find((m) => m.name === 'new');
      const fn = result.methods.find((m) => m.name === 'create_user');
      expect(method).toBeDefined();
      expect(method?.className).toBe('UserRepository');
      expect(method?.parameters).toContain('db');
      expect(fn).toBeDefined();
      expect(fn?.className).toBe('');
      expect(fn?.parameters).toContain('name');
    });
  });

  // ── PHP ───────────────────────────────────────────────────────────────────

  describeTreeSitter('PHP parsing', () => {
    const phpCode = `<?php
namespace App\\Controllers;

use App\\Services\\UserService;

class UserController {
    public function index() {
        return [];
    }

    private function validate() {}
}

interface UserRepositoryInterface {
    public function findById(int $id);
}
`;

    it('parses PHP file without error', () => {
      const result = service.parseFile('UserController.php', phpCode, 'php');
      expect(result.parseError).toBe(false);
      expect(result.language).toBe('php');
    });

    it('extracts PHP class symbols', () => {
      const result = service.parseFile('UserController.php', phpCode, 'php');
      const cls = result.symbols.find((s) => s.name === 'UserController');
      expect(cls).toBeDefined();
    });

    it('extracts PHP interface symbols', () => {
      const result = service.parseFile('UserController.php', phpCode, 'php');
      const iface = result.symbols.find((s) => s.name === 'UserRepositoryInterface');
      expect(iface).toBeDefined();
      expect(iface?.kind).toBe('interface');
    });
  });

  // ── JavaScript ────────────────────────────────────────────────────────────

  describeTreeSitter('JavaScript parsing', () => {
    const jsCode = `
import express from 'express';
import { authenticate } from './middleware';

class ApiRouter {
  constructor() {
    this.router = express.Router();
  }
}

function createHandler(fn) {
  return async (req, res) => {
    await fn(req, res);
  };
}

export default ApiRouter;
`;

    it('parses JavaScript file without error', () => {
      const result = service.parseFile('src/router.js', jsCode, 'javascript');
      expect(result.parseError).toBe(false);
      expect(result.language).toBe('javascript');
    });

    it('extracts JS class symbols', () => {
      const result = service.parseFile('src/router.js', jsCode, 'javascript');
      const cls = result.symbols.find((s) => s.name === 'ApiRouter');
      expect(cls).toBeDefined();
    });

    it('extracts JS function symbols', () => {
      const result = service.parseFile('src/router.js', jsCode, 'javascript');
      const fn = result.symbols.find((s) => s.name === 'createHandler');
      expect(fn).toBeDefined();
    });

    it('extracts JS imports', () => {
      const result = service.parseFile('src/router.js', jsCode, 'javascript');
      expect(result.imports.length).toBeGreaterThan(0);
      expect(result.imports[0].source).toBe('express');
    });
  });

  // ── Vue SFC ───────────────────────────────────────────────────────────────

  describeTreeSitter('Vue SFC parsing', () => {
    const vueCode = `
<template>
  <div>{{ message }}</div>
</template>

<script>
import { ref } from 'vue';

function useCounter() {
  const count = ref(0);
  return { count };
}

export default {
  setup() {
    return useCounter();
  }
};
</script>
`;

    it('parses Vue SFC without error', () => {
      const result = service.parseFile('src/App.vue', vueCode, 'vue');
      expect(result.parseError).toBe(false);
      expect(result.language).toBe('vue');
    });

    it('handles Vue SFC with no script block', () => {
      const result = service.parseFile('src/Empty.vue', '<template><div/></template>', 'vue');
      expect(result.parseError).toBe(false);
      expect(result.symbols).toHaveLength(0);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns empty structure for unsupported language', () => {
      const result = service.parseFile('Makefile', 'all: build', 'unknown');
      expect(result.symbols).toHaveLength(0);
      expect(result.parseError).toBe(false);
    });

    it('returns empty structure for CSS file', () => {
      const result = service.parseFile('styles.css', '.container { color: red; }', 'css');
      expect(result.symbols).toHaveLength(0);
    });

    it('handles malformed code gracefully', () => {
      const result = service.parseFile('broken.py', 'def ({{{{', 'python');
      // Either parses partially or sets parseError — should not throw
      expect(result).toBeDefined();
    });
  });
});
